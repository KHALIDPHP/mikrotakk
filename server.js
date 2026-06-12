require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mikrotik_saas_secret';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize DB
const db = require('./database/db');

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/mt', require('./routes/mikrotik'));

// Serve dashboard for authenticated routes
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Real-time monitoring via Socket.io
const { getConnection } = require('./mikrotik/api');

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  // Real-time device stats polling
  let pollInterval = null;

  socket.on('watch:device', async (deviceId) => {
    if (pollInterval) clearInterval(pollInterval);

    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    if (!device) return;

    async function sendStats() {
      try {
        const api = await getConnection(device);
        const resource = await api.getSystemResource();
        const interfaces = await api.getInterfaces();
        
        // Get PPPoE active count
        let pppoeCount = 0;
        let hotspotCount = 0;
        try {
          const pppoe = await api.getPPPoEUsers();
          pppoeCount = pppoe.active.length;
        } catch {}
        try {
          const hs = await api.getHotspotUsers();
          hotspotCount = hs.active.length;
        } catch {}

        socket.emit('device:stats', {
          deviceId,
          timestamp: new Date().toISOString(),
          cpu: parseInt(resource['cpu-load']) || 0,
          totalMemory: parseInt(resource['total-memory']) || 0,
          freeMemory: parseInt(resource['free-memory']) || 0,
          uptime: resource.uptime,
          interfaces: interfaces.filter(i => i.running === 'true').length,
          totalInterfaces: interfaces.length,
          pppoeActive: pppoeCount,
          hotspotActive: hotspotCount,
          status: 'online'
        });

        db.prepare('UPDATE devices SET status=?, last_seen=CURRENT_TIMESTAMP WHERE id=?')
          .run('online', deviceId);
      } catch (err) {
        socket.emit('device:stats', { deviceId, status: 'offline', error: err.message });
        db.prepare('UPDATE devices SET status=? WHERE id=?').run('offline', deviceId);
      }
    }

    await sendStats();
    pollInterval = setInterval(sendStats, 5000);
  });

  socket.on('stop:watch', () => {
    if (pollInterval) clearInterval(pollInterval);
  });

  socket.on('disconnect', () => {
    if (pollInterval) clearInterval(pollInterval);
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   🔌 MikroTik SaaS Control Panel          ║
║   🌐 http://localhost:${PORT}                  ║
║   👤 Admin: admin / admin123              ║
╚════════════════════════════════════════════╝
  `);
});

module.exports = { app, io };

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
app.set('socketio', io);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mikrotik_saas_secret';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/mt',      require('./routes/mikrotik'));
app.use('/api/setup',   require('./routes/setup'));

// Pages
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Socket.io Real-time Stats ───────────────────────────────────────────────
const { getConnection } = require('./mikrotik/api');
const db = require('./database/db');

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch { next(new Error('Invalid token')); }
});

io.on('connection', (socket) => {
  console.log(`✅ Socket connected: user=${socket.user.username}`);
  let interval = null;

  socket.on('watch:device', (deviceId) => {
    if (interval) clearInterval(interval);

    async function pushStats() {
      try {
        const dev = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
        if (!dev) {
          socket.emit('device:stats', { status: 'offline', error: 'الجهاز غير موجود' });
          return;
        }

        const api = await getConnection(dev);
        const resource = await api.getSystemResource();
        const ifaces   = await api.getInterfaces();
        let pppoeActive = 0, hotspotActive = 0;
        try { const p = await api.getPPPoEUsers(); pppoeActive = p.active.length; } catch {}
        try { const h = await api.getHotspotUsers(); hotspotActive = h.active.length; } catch {}

        socket.emit('device:stats', {
          cpu: parseInt(resource['cpu-load']) || 0,
          totalMemory: parseInt(resource['total-memory']) || 0,
          freeMemory:  parseInt(resource['free-memory'])  || 0,
          uptime: resource.uptime,
          pppoeActive,
          hotspotActive,
          status: 'online'
        });

        // Update status in SQLite
        await db.run('UPDATE devices SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?', ['online', deviceId]);
      } catch (err) {
        socket.emit('device:stats', { status: 'offline', error: err.message });
        // Update status in SQLite
        await db.run('UPDATE devices SET status = ? WHERE id = ?', ['offline', deviceId]);
      }
    }

    pushStats();
    interval = setInterval(pushStats, 5000);
  });

  socket.on('disconnect', () => {
    if (interval) clearInterval(interval);
    console.log(`❌ Socket disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  🔌  MikroTik SaaS Control Panel                ║
║  🌐  http://localhost:${PORT}                        ║
║  📡  https://mikrotakk-production.up.railway.app ║
╚══════════════════════════════════════════════════╝`);
});

module.exports = { app, io };

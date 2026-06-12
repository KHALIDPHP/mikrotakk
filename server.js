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

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mikrotik_saas_secret';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth',  require('./routes/auth'));
app.use('/api/mt',    require('./routes/mikrotik'));
app.use('/api/setup', require('./routes/setup'));

// Pages
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Socket.io Real-time Stats ───────────────────────────────────────────────
const { getConnection } = require('./mikrotik/api');

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.device = decoded.device;
    next();
  } catch { next(new Error('Invalid token')); }
});

io.on('connection', (socket) => {
  const dev = socket.device;
  if (!dev) { socket.disconnect(); return; }

  console.log(`✅ Socket → ${dev.identity || dev.host}`);
  let interval = null;

  async function pushStats() {
    try {
      const api = await getConnection(dev);
      const resource = await api.getSystemResource();
      const ifaces   = await api.getInterfaces();
      let pppoe = 0, hotspot = 0;
      try { const p = await api.getPPPoEUsers(); pppoe = p.active.length; } catch {}
      try { const h = await api.getHotspotUsers(); hotspot = h.active.length; } catch {}
      socket.emit('stats', {
        cpu: parseInt(resource['cpu-load']) || 0,
        totalMemory: parseInt(resource['total-memory']) || 0,
        freeMemory:  parseInt(resource['free-memory'])  || 0,
        uptime: resource.uptime,
        ifaceUp: ifaces.filter(i => i.running === 'true').length,
        ifaceTotal: ifaces.length,
        pppoe, hotspot, status: 'online'
      });
    } catch (err) {
      socket.emit('stats', { status: 'offline', error: err.message });
    }
  }

  pushStats();
  interval = setInterval(pushStats, 5000);
  socket.on('disconnect', () => { clearInterval(interval); });
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

const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { testConnection } = require('../mikrotik/api');
const auth = require('../middleware/authMiddleware');

// Get all devices
router.get('/', auth, (req, res) => {
  const devices = db.prepare('SELECT id, name, host, port, username, description, status, last_seen, model, version, serial, created_at FROM devices').all();
  res.json({ success: true, devices });
});

// Add device
router.post('/', auth, async (req, res) => {
  try {
    const { name, host, port, username, password, description } = req.body;

    if (!name || !host || !username || !password) {
      return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة' });
    }

    // Test connection first
    const test = await testConnection(host, port || 8728, username, password);

    const devicePort = port || 8728;
    const stmt = db.prepare(
      'INSERT INTO devices (name, host, port, username, password, description, status, model, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    const result = stmt.run(
      name, host, devicePort, username, password, description || '',
      test.success ? 'online' : 'offline',
      test.model || '', test.version || ''
    );

    if (test.success) {
      db.prepare('UPDATE devices SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(result.lastInsertRowid);
    }

    // Log activity
    db.prepare('INSERT INTO activity_log (user_id, device_id, action, details, ip) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, result.lastInsertRowid, 'add_device', `أضاف جهاز: ${name}`, req.ip);

    res.json({
      success: true,
      message: test.success ? 'تم إضافة الجهاز والاتصال ناجح ✅' : 'تم إضافة الجهاز (اتصال غير ناجح)',
      device: { id: result.lastInsertRowid, name, host, port: devicePort, status: test.success ? 'online' : 'offline' },
      connectionTest: test
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Test connection
router.post('/test', auth, async (req, res) => {
  try {
    const { host, port, username, password } = req.body;
    const result = await testConnection(host, port || 8728, username, password);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update device
router.put('/:id', auth, async (req, res) => {
  try {
    const { name, host, port, username, password, description } = req.body;
    const { id } = req.params;

    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    db.prepare(
      'UPDATE devices SET name=?, host=?, port=?, username=?, password=?, description=? WHERE id=?'
    ).run(name, host, port || 8728, username, password || device.password, description, id);

    res.json({ success: true, message: 'تم تحديث الجهاز بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete device
router.delete('/:id', auth, (req, res) => {
  try {
    const { id } = req.params;
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    db.prepare('DELETE FROM devices WHERE id = ?').run(id);

    db.prepare('INSERT INTO activity_log (user_id, action, details, ip) VALUES (?, ?, ?, ?)')
      .run(req.user.id, 'delete_device', `حذف جهاز: ${device.name}`, req.ip);

    res.json({ success: true, message: 'تم حذف الجهاز بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

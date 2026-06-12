const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { testConnection } = require('../mikrotik/api');
const auth = require('../middleware/authMiddleware');
const crypto = require('crypto');

const SAAS_URL = process.env.SAAS_URL || 'https://mikrotakk-production.up.railway.app';

// Get all devices
router.get('/', auth, async (req, res) => {
  try {
    const devices = await db.all(
      'SELECT id, name, host, port, username, description, status, last_seen, model, version, serial, token, created_at FROM devices'
    );
    res.json({ success: true, devices });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Add device
router.post('/', auth, async (req, res) => {
  try {
    const { name, host, port, username, password, description } = req.body;
    if (!name || !host || !username || !password)
      return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة' });

    // Generate unique device token for agent script
    const token = crypto.randomBytes(12).toString('hex');
    const devicePort = port || 8728;

    // Test connection (we still attempt, but don't fail if unreachable due to NAT)
    const test = await testConnection(host, devicePort, username, password);

    const result = await db.run(
      'INSERT INTO devices (name, host, port, username, password, description, status, model, version, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, host, devicePort, username, password, description || '',
       test.success ? 'online' : 'offline', test.model || '', test.version || '', token]
    );

    if (test.success) {
      await db.run('UPDATE devices SET last_seen = CURRENT_TIMESTAMP WHERE id = ?', [result.lastInsertRowid]);
    }

    await db.run(
      'INSERT INTO activity_log (user_id, device_id, action, details, ip) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, result.lastInsertRowid, 'add_device', `أضاف جهاز: ${name}`, req.ip]
    );

    const setupCommand = `/tool fetch url="${SAAS_URL}/api/setup/script/${token}" mode=https dst-path=gr_setup.rsc; :delay 3; /import gr_setup.rsc; :do {/file remove gr_setup.rsc} on-error={}`;

    res.json({
      success: true,
      message: test.success ? 'تم إضافة الجهاز والاتصال مباشر ناجح ✅' : 'تم إضافة الجهاز بنجاح. يرجى تشغيل سكريبت الربط التلقائي في المايكروتك.',
      device: { id: result.lastInsertRowid, name, host, port: devicePort, status: test.success ? 'online' : 'offline', token },
      setupCommand,
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
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    await db.run(
      'UPDATE devices SET name=?, host=?, port=?, username=?, password=?, description=? WHERE id=?',
      [name, host, port || 8728, username, password || device.password, description, req.params.id]
    );
    res.json({ success: true, message: 'تم تحديث الجهاز بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete device
router.delete('/:id', auth, async (req, res) => {
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    await db.run('DELETE FROM devices WHERE id = ?', [req.params.id]);
    await db.run(
      'INSERT INTO activity_log (user_id, action, details, ip) VALUES (?, ?, ?, ?)',
      [req.user.id, 'delete_device', `حذف جهاز: ${device.name}`, req.ip]
    );
    res.json({ success: true, message: 'تم حذف الجهاز بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

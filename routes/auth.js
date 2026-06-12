const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { testConnection } = require('../mikrotik/api');

const JWT_SECRET = process.env.JWT_SECRET || 'mikrotik_saas_secret';

// ─── Direct MikroTik Login ──────────────────────────────────────────────────
// User enters MikroTik IP/user/pass → test connection → issue JWT with device info
router.post('/mikrotik-login', async (req, res) => {
  try {
    const { host, port, username, password } = req.body;

    if (!host || !username) {
      return res.status(400).json({ success: false, message: 'عنوان IP واسم المستخدم مطلوبان' });
    }

    const apiPort = parseInt(port) || 8728;

    // Test MikroTik connection
    const test = await testConnection(host, apiPort, username, password || '');

    if (!test.success) {
      return res.status(401).json({
        success: false,
        message: `فشل الاتصال بـ MikroTik: ${test.error || 'تحقق من IP وبيانات الدخول'}`
      });
    }

    // Issue JWT with device credentials embedded
    const deviceInfo = {
      host,
      port: apiPort,
      username,
      password: password || '',
      identity: test.identity,
      model: test.model,
      version: test.version,
      arch: test.arch
    };

    const token = jwt.sign(
      { device: deviceInfo, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      success: true,
      token,
      device: deviceInfo
    });
  } catch (err) {
    console.error('MikroTik login error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Verify token ────────────────────────────────────────────────────────────
router.get('/verify', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ success: true, device: decoded.device });
  } catch {
    res.status(401).json({ success: false, message: 'جلسة منتهية' });
  }
});

module.exports = router;

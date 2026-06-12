const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../database/db');

const JWT_SECRET = process.env.JWT_SECRET || 'mikrotik_saas_secret';

// بيانات الدخول الثابتة
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ─── Login بمستخدم وكلمة مرور ثابتة ─────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' });
  }

  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  // الحصول على المعرف الخاص بالمستخدم من قاعدة البيانات
  let userId = 1;
  try {
    const user = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (user) userId = user.id;
  } catch (err) {
    console.error('Database query error:', err.message);
  }

  const token = jwt.sign(
    { id: userId, role: 'admin', username: ADMIN_USER },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({ success: true, token, username: ADMIN_USER });
});

// ─── Verify token ────────────────────────────────────────────────────────────
router.get('/verify', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ success: true, username: decoded.username });
  } catch {
    res.status(401).json({ success: false, message: 'جلسة منتهية' });
  }
});

module.exports = router;

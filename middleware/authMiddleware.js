const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'mikrotik_saas_secret';

module.exports = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'غير مصرح - سجّل الدخول أولاً' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    // Make device info easily accessible
    req.device = decoded.device;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'جلسة منتهية، يرجى إعادة الاتصال' });
  }
};

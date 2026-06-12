const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { getConnection } = require('../mikrotik/api');
const auth = require('../middleware/authMiddleware');

function getDevice(id) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!device) throw new Error('الجهاز غير موجود');
  return device;
}

// Get system info
router.get('/:id/system', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    
    const [identity, resource, rb] = await Promise.all([
      api.getSystemIdentity(),
      api.getSystemResource(),
      api.getSystemRouterboard()
    ]);

    // Update device status
    db.prepare('UPDATE devices SET status=?, last_seen=CURRENT_TIMESTAMP, model=?, version=? WHERE id=?')
      .run('online', rb.model || resource.board || '', resource.version || '', req.params.id);

    res.json({
      success: true,
      data: {
        identity: identity.name,
        model: rb.model || resource.board,
        version: resource.version,
        architecture: resource.architecture,
        cpu: resource['cpu-load'],
        cpuCount: resource['cpu-count'],
        totalMemory: resource['total-memory'],
        freeMemory: resource['free-memory'],
        totalHdd: resource['total-hdd-space'],
        freeHdd: resource['free-hdd-space'],
        uptime: resource.uptime,
        serial: rb['serial-number'] || '',
        firmware: rb['current-firmware'] || ''
      }
    });
  } catch (err) {
    db.prepare('UPDATE devices SET status=? WHERE id=?').run('offline', req.params.id);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get interfaces
router.get('/:id/interfaces', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const interfaces = await api.getInterfaces();
    res.json({ success: true, data: interfaces });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get interface traffic
router.get('/:id/traffic', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const interfaces = await api.getInterfaces();
    const traffic = await api.getInterfaceTraffic(interfaces.slice(0, 5));
    res.json({ success: true, data: traffic });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get PPPoE users
router.get('/:id/pppoe', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const data = await api.getPPPoEUsers();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Add PPPoE user
router.post('/:id/pppoe', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const { name, password, profile, service, comment } = req.body;
    await api.addPPPoEUser(name, password, profile, service, comment);

    db.prepare('INSERT INTO activity_log (user_id, device_id, action, details, ip) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, req.params.id, 'add_pppoe', `أضاف مستخدم PPPoE: ${name}`, req.ip);

    res.json({ success: true, message: `تم إضافة المستخدم ${name} بنجاح` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Remove PPPoE user
router.delete('/:id/pppoe/:userId', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    await api.removePPPoEUser(req.params.userId);
    res.json({ success: true, message: 'تم حذف المستخدم بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Toggle PPPoE user
router.patch('/:id/pppoe/:userId/toggle', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const { disabled } = req.body;
    
    if (disabled) {
      await api.disablePPPoEUser(req.params.userId);
    } else {
      await api.enablePPPoEUser(req.params.userId);
    }
    
    res.json({ success: true, message: disabled ? 'تم تعطيل المستخدم' : 'تم تفعيل المستخدم' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Disconnect PPPoE active session
router.delete('/:id/pppoe/active/:sessionId', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    await api.disconnectPPPoEActive(req.params.sessionId);
    res.json({ success: true, message: 'تم قطع الاتصال بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get PPPoE profiles
router.get('/:id/pppoe/profiles', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const data = await api.getPPPoEProfiles();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get Hotspot users
router.get('/:id/hotspot', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const data = await api.getHotspotUsers();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Add Hotspot user
router.post('/:id/hotspot', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const { name, password, profile, comment, limitUptime, limitBytes } = req.body;
    await api.addHotspotUser(name, password, profile, comment, limitUptime, limitBytes);

    db.prepare('INSERT INTO activity_log (user_id, device_id, action, details, ip) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, req.params.id, 'add_hotspot', `أضاف مستخدم Hotspot: ${name}`, req.ip);

    res.json({ success: true, message: `تم إضافة المستخدم ${name} بنجاح` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Remove Hotspot user
router.delete('/:id/hotspot/:userId', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    await api.removeHotspotUser(req.params.userId);
    res.json({ success: true, message: 'تم حذف المستخدم بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get Queues
router.get('/:id/queues', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const data = await api.getQueues();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Add Queue
router.post('/:id/queues', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const { name, target, maxLimit, comment } = req.body;
    await api.addQueue(name, target, maxLimit, comment);
    res.json({ success: true, message: 'تم إضافة Queue بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Remove Queue
router.delete('/:id/queues/:queueId', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    await api.removeQueue(req.params.queueId);
    res.json({ success: true, message: 'تم حذف Queue بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Set Queue Limit
router.patch('/:id/queues/:queueId/limit', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const { maxLimit } = req.body;
    await api.setQueueLimit(req.params.queueId, maxLimit);
    res.json({ success: true, message: 'تم تعديل الحد الأقصى بنجاح' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get Firewall
router.get('/:id/firewall', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const data = await api.getFirewallRules();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get IP Pools
router.get('/:id/ippools', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const data = await api.getIPPools();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get IP Addresses
router.get('/:id/ipaddresses', auth, async (req, res) => {
  try {
    const device = getDevice(req.params.id);
    const api = await getConnection(device);
    const data = await api.getIPAddresses();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Activity log
router.get('/logs', auth, (req, res) => {
  const logs = db.prepare(`
    SELECT a.*, u.username 
    FROM activity_log a 
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.created_at DESC 
    LIMIT 100
  `).all();
  res.json({ success: true, data: logs });
});

module.exports = router;

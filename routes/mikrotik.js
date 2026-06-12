const express = require('express');
const router = express.Router();
const { getConnection } = require('../mikrotik/api');
const auth = require('../middleware/authMiddleware');

// Helper: get API connection using device info from JWT
async function getApi(req) {
  const device = req.device;
  if (!device) throw new Error('لا يوجد جهاز في الجلسة - أعد تسجيل الدخول');
  return await getConnection(device);
}

// ─── System ──────────────────────────────────────────────────────────────────
router.get('/system', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    const [identity, resource, rb] = await Promise.all([
      api.getSystemIdentity(), api.getSystemResource(), api.getSystemRouterboard()
    ]);
    res.json({
      success: true, data: {
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
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Interfaces ───────────────────────────────────────────────────────────────
router.get('/interfaces', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    res.json({ success: true, data: await api.getInterfaces() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Traffic ─────────────────────────────────────────────────────────────────
router.get('/traffic', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    const ifaces = await api.getInterfaces();
    res.json({ success: true, data: await api.getInterfaceTraffic(ifaces.slice(0, 5)) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── PPPoE ────────────────────────────────────────────────────────────────────
router.get('/pppoe', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    res.json({ success: true, data: await api.getPPPoEUsers() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/pppoe', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    const { name, password, profile, service, comment } = req.body;
    await api.addPPPoEUser(name, password, profile, service, comment);
    res.json({ success: true, message: `✅ تم إضافة ${name} بنجاح` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/pppoe/:uid', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    await api.removePPPoEUser(req.params.uid);
    res.json({ success: true, message: 'تم حذف المستخدم' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/pppoe/:uid/toggle', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    if (req.body.disabled) await api.disablePPPoEUser(req.params.uid);
    else await api.enablePPPoEUser(req.params.uid);
    res.json({ success: true, message: req.body.disabled ? 'تم التعطيل' : 'تم التفعيل' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/pppoe/active/:sid', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    await api.disconnectPPPoEActive(req.params.sid);
    res.json({ success: true, message: 'تم قطع الاتصال' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/pppoe/profiles', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    res.json({ success: true, data: await api.getPPPoEProfiles() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Hotspot ──────────────────────────────────────────────────────────────────
router.get('/hotspot', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    res.json({ success: true, data: await api.getHotspotUsers() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/hotspot', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    const { name, password, profile, comment, limitUptime, limitBytes } = req.body;
    await api.addHotspotUser(name, password, profile, comment, limitUptime, limitBytes);
    res.json({ success: true, message: `✅ تم إضافة ${name} بنجاح` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/hotspot/:uid', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    await api.removeHotspotUser(req.params.uid);
    res.json({ success: true, message: 'تم الحذف' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Queues ───────────────────────────────────────────────────────────────────
router.get('/queues', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    res.json({ success: true, data: await api.getQueues() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/queues', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    const { name, target, maxLimit, comment } = req.body;
    await api.addQueue(name, target, maxLimit, comment);
    res.json({ success: true, message: '✅ تم إضافة Queue بنجاح' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/queues/:qid', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    await api.removeQueue(req.params.qid);
    res.json({ success: true, message: 'تم الحذف' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/queues/:qid/limit', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    await api.setQueueLimit(req.params.qid, req.body.maxLimit);
    res.json({ success: true, message: '✅ تم تعديل السرعة' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Firewall ─────────────────────────────────────────────────────────────────
router.get('/firewall', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    res.json({ success: true, data: await api.getFirewallRules() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── IP Pools ─────────────────────────────────────────────────────────────────
router.get('/ippools', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    res.json({ success: true, data: await api.getIPPools() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── IP Addresses ────────────────────────────────────────────────────────────
router.get('/ipaddresses', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    res.json({ success: true, data: await api.getIPAddresses() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── TERMINAL (RouterOS Command Executor) ────────────────────────────────────
router.post('/terminal', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    const { command, params } = req.body;

    if (!command) return res.status(400).json({ success: false, message: 'الأمر مطلوب' });

    // Safety: only allow read/print commands unless explicitly enabled
    const cmd = command.trim();
    const result = await api.executeCommand(cmd, params || []);

    res.json({ success: true, data: result, command: cmd });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, command: req.body.command });
  }
});

module.exports = router;

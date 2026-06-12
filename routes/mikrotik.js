const express = require('express');
const router = express.Router();
const { getConnection } = require('../mikrotik/api');
const auth = require('../middleware/authMiddleware');
const db = require('../database/db');
const crypto = require('crypto');
const setupRoute = require('./setup');

const SAAS_URL = process.env.SAAS_URL || 'https://mikrotakk-production.up.railway.app';

// Helper: executes script command on the agent device using poll-result mechanism
async function runAgentCommand(deviceId, token, commandScript) {
  const commandId = crypto.randomBytes(6).toString('hex');
  
  // Wrap command with callback reporting result
  const wrappedCommand = `:do {
    ${commandScript}
    /tool fetch url="${SAAS_URL}/api/setup/agent-result\\?token=${token}&commandId=${commandId}&status=success" keep-result=no
  } on-error={
    /tool fetch url="${SAAS_URL}/api/setup/agent-result\\?token=${token}&commandId=${commandId}&status=error" keep-result=no
  }`;

  // Insert command to queue
  await db.run(
    'INSERT INTO device_commands (device_id, command, command_id) VALUES (?, ?, ?)',
    [deviceId, wrappedCommand, commandId]
  );

  // Wait for the agent to pull and execute it
  return new Promise((resolve, reject) => {
    const handler = (data) => {
      if (data.commandId === commandId) {
        setupRoute.commandEvents.off(deviceId.toString(), handler);
        if (data.success) resolve({ success: true, message: data.message });
        else reject(new Error(data.message || 'فشل تنفيذ الأمر على المايكروتك'));
      }
    };
    setupRoute.commandEvents.on(deviceId.toString(), handler);
    
    // Timeout after 8 seconds
    setTimeout(() => {
      setupRoute.commandEvents.off(deviceId.toString(), handler);
      reject(new Error('انتهت مهلة استجابة المايكروتك (تأكد من تشغيل كود الربط)'));
    }, 8000);
  });
}

// Helper: get API connection using device info from database
async function getApi(req) {
  const { deviceId } = req.params;
  if (!deviceId) throw new Error('لا يوجد جهاز محدد في الطلب');
  
  const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
  if (!device) throw new Error('لم يتم العثور على الجهاز في قاعدة البيانات');
  
  // If it's an agent device, we don't do direct connections
  if (device.token) {
    throw new Error('agent_device');
  }
  
  return await getConnection(device);
}

// ─── Logs (Must be before /:deviceId routes) ─────────────────────────────────
router.get('/logs', auth, async (req, res) => {
  try {
    const logs = await db.all('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 100');
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── System ──────────────────────────────────────────────────────────────────
router.get('/:deviceId/system', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      // Return basic dynamic status for agent
      return res.json({
        success: true, data: {
          identity: device.name,
          model: device.model || 'MikroTik Router (Agent)',
          version: device.version || '',
          architecture: '---',
          cpu: 0,
          cpuCount: 1,
          totalMemory: 0,
          freeMemory: 0,
          totalHdd: 0,
          freeHdd: 0,
          uptime: '---',
          serial: device.serial || '',
          firmware: ''
        }
      });
    }

    const api = await getConnection(device);
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
router.get('/:deviceId/interfaces', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      // 1. Return cached interfaces
      const cached = await db.get('SELECT value FROM device_cache WHERE device_id = ? AND key = "interfaces"', [device.id]);
      const data = cached ? JSON.parse(cached.value) : [];

      // 2. Queue background refresh
      const dumpCommand = `:local out ""
      :foreach i in=[/interface find] do={
        :set out (\$out . [/interface get \$i name] . "," . [/interface get \$i type] . "," . [/interface get \$i mac-address] . "," . [/interface get \$i mtu] . "," . [/interface get \$i running] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-interfaces\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, data });
    }

    const api = await getConnection(device);
    res.json({ success: true, data: await api.getInterfaces() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Traffic ─────────────────────────────────────────────────────────────────
router.get('/:deviceId/traffic', auth, async (req, res) => {
  try {
    const api = await getApi(req);
    const ifaces = await api.getInterfaces();
    res.json({ success: true, data: await api.getInterfaceTraffic(ifaces.slice(0, 5)) });
  } catch (err) { 
    if (err.message === 'agent_device') {
      return res.json({ success: true, data: [] }); // Disable real-time traffic graph for NAT agents for now
    }
    res.status(500).json({ success: false, message: err.message }); 
  }
});

// ─── PPPoE ────────────────────────────────────────────────────────────────────
router.get('/:deviceId/pppoe', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      // 1. Return cached PPPoE secrets
      const cached = await db.get('SELECT value FROM device_cache WHERE device_id = ? AND key = "pppoe"', [device.id]);
      const data = cached ? JSON.parse(cached.value) : { secrets: [], active: [] };

      // 2. Queue background refresh
      const dumpCommand = `:local out ""
      :foreach s in=[/ppp/secret find] do={
        :set out (\$out . [/ppp/secret get \$s name] . "," . [/ppp/secret get \$s password] . "," . [/ppp/secret get \$s profile] . "," . [/ppp/secret get \$s service] . "," . [/ppp/secret get \$s comment] . "," . [/ppp/secret get \$s disabled] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-pppoe\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, data });
    }

    const api = await getConnection(device);
    res.json({ success: true, data: await api.getPPPoEUsers() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/:deviceId/pppoe', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { name, password, profile, service, comment } = req.body;
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const command = `/ppp/secret/add name="${name}" password="${password}" profile="${profile || 'default'}" service="${service || 'pppoe'}" comment="${comment || ''}"`;
      await runAgentCommand(device.id, device.token, command);
      
      // Auto queue list update
      const dumpCommand = `:local out ""
      :foreach s in=[/ppp/secret find] do={
        :set out (\$out . [/ppp/secret get \$s name] . "," . [/ppp/secret get \$s password] . "," . [/ppp/secret get \$s profile] . "," . [/ppp/secret get \$s service] . "," . [/ppp/secret get \$s comment] . "," . [/ppp/secret get \$s disabled] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-pppoe\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, message: `✅ تم إضافة ${name} بنجاح` });
    }

    const api = await getConnection(device);
    await api.addPPPoEUser(name, password, profile, service, comment);
    res.json({ success: true, message: `✅ تم إضافة ${name} بنجاح` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/:deviceId/pppoe/:uid', auth, async (req, res) => {
  const { deviceId, uid } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const command = `/ppp/secret/remove [find where .id="${uid}" or name="${uid}"]`;
      await runAgentCommand(device.id, device.token, command);

      // Auto queue list update
      const dumpCommand = `:local out ""
      :foreach s in=[/ppp/secret find] do={
        :set out (\$out . [/ppp/secret get \$s name] . "," . [/ppp/secret get \$s password] . "," . [/ppp/secret get \$s profile] . "," . [/ppp/secret get \$s service] . "," . [/ppp/secret get \$s comment] . "," . [/ppp/secret get \$s disabled] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-pppoe\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, message: 'تم حذف المستخدم' });
    }

    const api = await getConnection(device);
    await api.removePPPoEUser(uid);
    res.json({ success: true, message: 'تم حذف المستخدم' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/:deviceId/pppoe/:uid/toggle', auth, async (req, res) => {
  const { deviceId, uid } = req.params;
  const { disabled } = req.body;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const command = `/ppp/secret/set [find where .id="${uid}" or name="${uid}"] disabled=${disabled ? 'yes' : 'no'}`;
      await runAgentCommand(device.id, device.token, command);

      // Auto queue list update
      const dumpCommand = `:local out ""
      :foreach s in=[/ppp/secret find] do={
        :set out (\$out . [/ppp/secret get \$s name] . "," . [/ppp/secret get \$s password] . "," . [/ppp/secret get \$s profile] . "," . [/ppp/secret get \$s service] . "," . [/ppp/secret get \$s comment] . "," . [/ppp/secret get \$s disabled] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-pppoe\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, message: disabled ? 'تم التعطيل' : 'تم التفعيل' });
    }

    const api = await getConnection(device);
    if (disabled) await api.disablePPPoEUser(uid);
    else await api.enablePPPoEUser(uid);
    res.json({ success: true, message: disabled ? 'تم التعطيل' : 'تم التفعيل' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/:deviceId/pppoe/active/:sid', auth, async (req, res) => {
  const { deviceId, sid } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const command = `/ppp/active/remove [find where .id="${sid}"]`;
      await runAgentCommand(device.id, device.token, command);
      return res.json({ success: true, message: 'تم قطع الاتصال' });
    }

    const api = await getConnection(device);
    await api.disconnectPPPoEActive(sid);
    res.json({ success: true, message: 'تم قطع الاتصال' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/:deviceId/pppoe/profiles', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      return res.json({ success: true, data: [{ name: 'default' }, { name: 'default-profile' }] });
    }

    const api = await getConnection(device);
    res.json({ success: true, data: await api.getPPPoEProfiles() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Hotspot ──────────────────────────────────────────────────────────────────
router.get('/:deviceId/hotspot', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const cached = await db.get('SELECT value FROM device_cache WHERE device_id = ? AND key = "hotspot"', [device.id]);
      const data = cached ? JSON.parse(cached.value) : { users: [], active: [] };

      const dumpCommand = `:local out ""
      :foreach u in=[/ip/hotspot/user find] do={
        :set out (\$out . [/ip/hotspot/user get \$u name] . "," . [/ip/hotspot/user get \$u profile] . "," . [/ip/hotspot/user get \$u limit-uptime] . "," . [/ip/hotspot/user get \$u limit-bytes-total] . "," . [/ip/hotspot/user get \$u comment] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-hotspot\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, data });
    }

    const api = await getConnection(device);
    res.json({ success: true, data: await api.getHotspotUsers() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/:deviceId/hotspot', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { name, password, profile, comment, limitUptime, limitBytes } = req.body;
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const command = `/ip/hotspot/user/add name="${name}" password="${password}" profile="${profile || 'default'}" ${limitUptime ? `limit-uptime="${limitUptime}"` : ''} ${limitBytes ? `limit-bytes-total="${limitBytes}"` : ''} comment="${comment || ''}"`;
      await runAgentCommand(device.id, device.token, command);

      const dumpCommand = `:local out ""
      :foreach u in=[/ip/hotspot/user find] do={
        :set out (\$out . [/ip/hotspot/user get \$u name] . "," . [/ip/hotspot/user get \$u profile] . "," . [/ip/hotspot/user get \$u limit-uptime] . "," . [/ip/hotspot/user get \$u limit-bytes-total] . "," . [/ip/hotspot/user get \$u comment] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-hotspot\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, message: `✅ تم إضافة ${name} بنجاح` });
    }

    const api = await getConnection(device);
    await api.addHotspotUser(name, password, profile, comment, limitUptime, limitBytes);
    res.json({ success: true, message: `✅ تم إضافة ${name} بنجاح` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/:deviceId/hotspot/:uid', auth, async (req, res) => {
  const { deviceId, uid } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const command = `/ip/hotspot/user/remove [find where .id="${uid}" or name="${uid}"]`;
      await runAgentCommand(device.id, device.token, command);

      const dumpCommand = `:local out ""
      :foreach u in=[/ip/hotspot/user find] do={
        :set out (\$out . [/ip/hotspot/user get \$u name] . "," . [/ip/hotspot/user get \$u profile] . "," . [/ip/hotspot/user get \$u limit-uptime] . "," . [/ip/hotspot/user get \$u limit-bytes-total] . "," . [/ip/hotspot/user get \$u comment] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-hotspot\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, message: 'تم الحذف' });
    }

    const api = await getConnection(device);
    await api.removeHotspotUser(uid);
    res.json({ success: true, message: 'تم الحذف' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Queues ───────────────────────────────────────────────────────────────────
router.get('/:deviceId/queues', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const cached = await db.get('SELECT value FROM device_cache WHERE device_id = ? AND key = "queues"', [device.id]);
      const data = cached ? JSON.parse(cached.value) : [];

      const dumpCommand = `:local out ""
      :foreach q in=[/queue/simple find] do={
        :set out (\$out . [/queue/simple get \$q name] . "," . [/queue/simple get \$q target] . "," . [/queue/simple get \$q max-limit] . "," . [/queue/simple get \$q comment] . "," . [/queue/simple get \$q disabled] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-queues\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, data });
    }

    const api = await getConnection(device);
    res.json({ success: true, data: await api.getQueues() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/:deviceId/queues', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { name, target, maxLimit, comment } = req.body;
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const command = `/queue/simple/add name="${name}" target="${target}" max-limit="${maxLimit}" comment="${comment || ''}"`;
      await runAgentCommand(device.id, device.token, command);

      const dumpCommand = `:local out ""
      :foreach q in=[/queue/simple find] do={
        :set out (\$out . [/queue/simple get \$q name] . "," . [/queue/simple get \$q target] . "," . [/queue/simple get \$q max-limit] . "," . [/queue/simple get \$q comment] . "," . [/queue/simple get \$q disabled] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-queues\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, message: '✅ تم إضافة Queue بنجاح' });
    }

    const api = await getConnection(device);
    await api.addQueue(name, target, maxLimit, comment);
    res.json({ success: true, message: '✅ تم إضافة Queue بنجاح' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/:deviceId/queues/:qid', auth, async (req, res) => {
  const { deviceId, qid } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const command = `/queue/simple/remove [find where .id="${qid}" or name="${qid}"]`;
      await runAgentCommand(device.id, device.token, command);

      const dumpCommand = `:local out ""
      :foreach q in=[/queue/simple find] do={
        :set out (\$out . [/queue/simple get \$q name] . "," . [/queue/simple get \$q target] . "," . [/queue/simple get \$q max-limit] . "," . [/queue/simple get \$q comment] . "," . [/queue/simple get \$q disabled] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-queues\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, message: 'تم الحذف' });
    }

    const api = await getConnection(device);
    await api.removeQueue(qid);
    res.json({ success: true, message: 'تم الحذف' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/:deviceId/queues/:qid/limit', auth, async (req, res) => {
  const { deviceId, qid } = req.params;
  const { maxLimit } = req.body;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const command = `/queue/simple/set [find where .id="${qid}" or name="${qid}"] max-limit="${maxLimit}"`;
      await runAgentCommand(device.id, device.token, command);

      const dumpCommand = `:local out ""
      :foreach q in=[/queue/simple find] do={
        :set out (\$out . [/queue/simple get \$q name] . "," . [/queue/simple get \$q target] . "," . [/queue/simple get \$q max-limit] . "," . [/queue/simple get \$q comment] . "," . [/queue/simple get \$q disabled] . ";")
      }
      /tool fetch url="${SAAS_URL}/api/setup/agent-push-queues\\?token=${device.token}" http-method=post http-data=\$out keep-result=no`;
      await db.run('INSERT INTO device_commands (device_id, command) VALUES (?, ?)', [device.id, dumpCommand]);

      return res.json({ success: true, message: '✅ تم تعديل السرعة' });
    }

    const api = await getConnection(device);
    await api.setQueueLimit(qid, maxLimit);
    res.json({ success: true, message: '✅ تم تعديل السرعة' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Firewall ─────────────────────────────────────────────────────────────────
router.get('/:deviceId/firewall', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      // Return empty structure or placeholders for agent for now
      return res.json({ success: true, data: { filter: [], nat: [] } });
    }

    const api = await getConnection(device);
    res.json({ success: true, data: await api.getFirewallRules() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── IP Pools ─────────────────────────────────────────────────────────────────
router.get('/:deviceId/ippools', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      // Return empty lists for agent pools for now
      return res.json({ success: true, data: { pools: [], used: [] } });
    }

    const api = await getConnection(device);
    res.json({ success: true, data: await api.getIPPools() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── IP Addresses ────────────────────────────────────────────────────────────
router.get('/:deviceId/ipaddresses', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      return res.json({ success: true, data: [] });
    }

    const api = await getConnection(device);
    res.json({ success: true, data: await api.getIPAddresses() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── TERMINAL (RouterOS Command Executor) ────────────────────────────────────
router.post('/:deviceId/terminal', auth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { command, params } = req.body;
    if (!command) return res.status(400).json({ success: false, message: 'الأمر مطلوب' });
    const cmd = command.trim();

    const device = await db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
    if (!device) return res.status(404).json({ success: false, message: 'الجهاز غير موجود' });

    if (device.token) {
      const result = await runAgentCommand(device.id, device.token, cmd);
      return res.json({ success: true, data: result, command: cmd });
    }

    const api = await getConnection(device);
    const result = await api.executeCommand(cmd, params || []);
    res.json({ success: true, data: result, command: cmd });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, command: req.body.command });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database/db');
const EventEmitter = require('events');

const SAAS_URL = process.env.SAAS_URL || 'https://mikrotakk-production.up.railway.app';

// Event emitter to coordinate NAT command executions
const commandEvents = new EventEmitter();
router.commandEvents = commandEvents; // Export to other routes if needed

// ─── Serve the RouterOS script file ──────────────────────────────────────────
router.get('/script/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const device = await db.get('SELECT * FROM devices WHERE token = ?', [token]);
    if (!device) {
      return res.status(404).type('text').send('# Error: Invalid token');
    }

    res.type('text/plain').send(buildScript(token, device.username, device.password, SAAS_URL));
  } catch (err) {
    res.status(500).type('text').send('# Error: ' + err.message);
  }
});

// ─── MikroTik calls this after running the script to finalize info ────────────
router.post('/register', async (req, res) => {
  const { token, identity, model, version, ip, host } = req.body;

  try {
    const device = await db.get('SELECT * FROM devices WHERE token = ?', [token]);
    if (!device) {
      return res.status(401).type('text').send('# Error: Invalid token');
    }

    // Update device details
    await db.run(
      'UPDATE devices SET name = ?, model = ?, version = ?, host = ?, status = "online", last_seen = CURRENT_TIMESTAMP WHERE id = ?',
      [identity || device.name, model || '', version || '', host || ip || device.host, device.id]
    );

    console.log(`✅ MikroTik registered via script: ${identity} (${host || ip})`);
    res.type('text').send(`# Success! ${identity} registered.\n:put "Installation complete!"`);
  } catch (err) {
    res.status(500).type('text').send('# Error: ' + err.message);
  }
});

// ─── Agent Polling Endpoint (Runs every 3 seconds on MikroTik) ────────────────
router.get('/agent-poll', async (req, res) => {
  const { token, cpu, freeMem, totalMem, uptime, pppoeActive, hotspotActive } = req.query;

  try {
    const device = await db.get('SELECT * FROM devices WHERE token = ?', [token]);
    if (!device) {
      return res.status(401).send('# Error: Unauthorized');
    }

    // Update status and resources
    await db.run('UPDATE devices SET status = "online", last_seen = CURRENT_TIMESTAMP WHERE id = ?', [device.id]);

    // Push live stats to connected socket clients
    const io = req.app.get('socketio');
    if (io) {
      io.emit('device:stats', {
        cpu: parseInt(cpu) || 0,
        totalMemory: parseInt(totalMem) || 0,
        freeMemory: parseInt(freeMem) || 0,
        uptime: uptime || '',
        pppoeActive: parseInt(pppoeActive) || 0,
        hotspotActive: parseInt(hotspotActive) || 0,
        status: 'online'
      });
    }

    // Check if there are pending commands to execute
    const cmd = await db.get('SELECT * FROM device_commands WHERE device_id = ? ORDER BY id ASC LIMIT 1', [device.id]);
    if (cmd) {
      // Return command as executable script
      res.type('text/plain').send(cmd.command);
      // Delete command from queue
      await db.run('DELETE FROM device_commands WHERE id = ?', [cmd.id]);
    } else {
      res.type('text/plain').send('# Ok');
    }
  } catch (err) {
    res.status(500).type('text').send('# Error: ' + err.message);
  }
});

// ─── Agent reports result of executed command ───────────────────────────────
router.get('/agent-result', async (req, res) => {
  const { token, commandId, status, message } = req.query;

  try {
    const device = await db.get('SELECT id FROM devices WHERE token = ?', [token]);
    if (!device) return res.status(401).send('Unauthorized');

    // Emit event to unblock dashboard API route
    commandEvents.emit(device.id.toString(), {
      commandId,
      success: status === 'success',
      message: message || (status === 'success' ? 'تم التنفيذ بنجاح' : 'فشل التنفيذ')
    });

    res.send('Ok');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ─── Agent pushes PPPoE list ──────────────────────────────────────────────────
router.post('/agent-push-pppoe', async (req, res) => {
  const { token } = req.query;
  const rawData = req.body; // text payload

  try {
    const device = await db.get('SELECT id FROM devices WHERE token = ?', [token]);
    if (!device) return res.status(401).send('Unauthorized');

    // Parse comma-semicolon separated list
    // Format: name,password,profile,service,comment,disabled;
    const items = (typeof rawData === 'string' ? rawData : rawData.toString())
      .split(';')
      .filter(Boolean)
      .map(row => {
        const [name, password, profile, service, comment, disabled] = row.split(',');
        return { name, password, profile, service, comment, disabled };
      });

    const parsedJson = JSON.stringify({ secrets: items, active: [] }); // simple format

    // Update cache
    await db.run(
      'INSERT INTO device_cache (device_id, key, value, updated_at) VALUES (?, "pppoe", ?, CURRENT_TIMESTAMP) ON CONFLICT(device_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      [device.id, parsedJson]
    );

    // Notify UI via socket
    const io = req.app.get('socketio');
    if (io) {
      io.emit('pppoe:updated', { deviceId: device.id, data: { secrets: items, active: [] } });
    }

    res.send('Ok');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ─── Agent pushes Hotspot list ────────────────────────────────────────────────
router.post('/agent-push-hotspot', async (req, res) => {
  const { token } = req.query;
  const rawData = req.body;
  try {
    const device = await db.get('SELECT id FROM devices WHERE token = ?', [token]);
    if (!device) return res.status(401).send('Unauthorized');

    const items = (typeof rawData === 'string' ? rawData : rawData.toString())
      .split(';')
      .filter(Boolean)
      .map(row => {
        const [name, profile, limitUptime, limitBytesTotal, comment] = row.split(',');
        return { name, profile, 'limit-uptime': limitUptime, 'limit-bytes-total': limitBytesTotal, comment };
      });

    const parsedJson = JSON.stringify({ users: items, active: [] });
    await db.run(
      'INSERT INTO device_cache (device_id, key, value, updated_at) VALUES (?, "hotspot", ?, CURRENT_TIMESTAMP) ON CONFLICT(device_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      [device.id, parsedJson]
    );

    const io = req.app.get('socketio');
    if (io) {
      io.emit('hotspot:updated', { deviceId: device.id, data: { users: items, active: [] } });
    }
    res.send('Ok');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Agent pushes Simple Queues list ──────────────────────────────────────────
router.post('/agent-push-queues', async (req, res) => {
  const { token } = req.query;
  const rawData = req.body;
  try {
    const device = await db.get('SELECT id FROM devices WHERE token = ?', [token]);
    if (!device) return res.status(401).send('Unauthorized');

    const items = (typeof rawData === 'string' ? rawData : rawData.toString())
      .split(';')
      .filter(Boolean)
      .map(row => {
        const [name, target, maxLimit, comment, disabled] = row.split(',');
        return { name, target, 'max-limit': maxLimit, comment, disabled };
      });

    const parsedJson = JSON.stringify(items);
    await db.run(
      'INSERT INTO device_cache (device_id, key, value, updated_at) VALUES (?, "queues", ?, CURRENT_TIMESTAMP) ON CONFLICT(device_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      [device.id, parsedJson]
    );

    const io = req.app.get('socketio');
    if (io) {
      io.emit('queues:updated', { deviceId: device.id, data: items });
    }
    res.send('Ok');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Agent pushes Interfaces list ─────────────────────────────────────────────
router.post('/agent-push-interfaces', async (req, res) => {
  const { token } = req.query;
  const rawData = req.body;
  try {
    const device = await db.get('SELECT id FROM devices WHERE token = ?', [token]);
    if (!device) return res.status(401).send('Unauthorized');

    const items = (typeof rawData === 'string' ? rawData : rawData.toString())
      .split(';')
      .filter(Boolean)
      .map(row => {
        const [name, type, macAddress, mtu, running] = row.split(',');
        return { name, type, 'mac-address': macAddress, mtu, running };
      });

    const parsedJson = JSON.stringify(items);
    await db.run(
      'INSERT INTO device_cache (device_id, key, value, updated_at) VALUES (?, "interfaces", ?, CURRENT_TIMESTAMP) ON CONFLICT(device_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      [device.id, parsedJson]
    );

    const io = req.app.get('socketio');
    if (io) {
      io.emit('interfaces:updated', { deviceId: device.id, data: items });
    }
    res.send('Ok');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── RouterOS Script Builder ─────────────────────────────────────────────────
function buildScript(token, apiUser, apiPass, saasUrl) {
  return `# MikroTik SaaS - Auto Setup Script
# Generated for: ${saasUrl}
# Token: ${token}

:log info "MikroTik SaaS: Starting setup..."
:put "Starting MikroTik SaaS setup..."

# Step 1: Create API group with required permissions
:do {
  /user group add name=saas-api-group policy=read,write,api,!local,!telnet,!ssh,!ftp,!reboot,!policy,!password,!sniff,!sensitive,!romon comment="SaaS API Group"
  :log info "MikroTik SaaS: API group created"
} on-error={
  :log info "MikroTik SaaS: API group already exists"
}

# Step 2: Create API user
:do {
  /user remove [find name="${apiUser}"]
} on-error={}
/user add name="${apiUser}" password="${apiPass}" group=saas-api-group comment="MikroTik SaaS API User - Do Not Delete"
:log info "MikroTik SaaS: API user created"

# Step 3: Enable API service
/ip service set api disabled=no port=8728
:log info "MikroTik SaaS: API service enabled"

# Step 4: Get device info
:local identity [/system identity get name]
:local routerModel ""
:local routerVersion [/system resource get version]
:do {
  :set routerModel [/system routerboard get model]
} on-error={ :set routerModel "Unknown" }

# Step 5: Get public IP
:local publicIP ""
:do {
  :local fetchResult [/tool fetch url="https://api.ipify.org" as-value output=user]
  :set publicIP ($fetchResult->"data")
} on-error={ :set publicIP "unknown" }

:log info ("MikroTik SaaS: Device info - " . $identity . " / " . $publicIP)

# Step 6: Register with SaaS
:local postData ("{\"token\":\"${token}\",\"identity\":\"" . $identity . "\",\"model\":\"" . $routerModel . "\",\"version\":\"" . $routerVersion . "\",\"ip\":\"" . $publicIP . "\",\"host\":\"" . $publicIP . "\",\"apiUser\":\"${apiUser}\",\"apiPass\":\"${apiPass}\",\"port\":8728}")

:do {
  /tool fetch url="${saasUrl}/api/setup/register" \\
    mode=https \\
    http-method=post \\
    http-header-field="Content-Type: application/json" \\
    http-data=$postData \\
    dst-path=reg_result.txt
  :log info "MikroTik SaaS: Registration request sent"
} on-error={
  :log error "MikroTik SaaS: Registration failed - check connectivity"
}

# Step 7: Create Agent Polling Scheduler
/system script remove [find name="saas-poll"]
/system script add name="saas-poll" source={
  :local cpu [/system resource get cpu-load]
  :local freeMem [/system resource get free-memory]
  :local totalMem [/system resource get total-memory]
  :local uptime [/system resource get uptime]
  :local pppoeActive 0
  :local hotspotActive 0
  :do { :set pppoeActive [/ppp active print count-only] } on-error={}
  :do { :set hotspotActive [/ip hotspot active print count-only] } on-error={}

  /tool fetch url="${saasUrl}/api/setup/agent-poll\?token=${token}&cpu=\$cpu&freeMem=\$freeMem&totalMem=\$totalMem&uptime=\$uptime&pppoeActive=\$pppoeActive&hotspotActive=\$hotspotActive" mode=https dst-path=saas_action.rsc;
  :if ([/file find name=saas_action.rsc] != "") do={
    :if ([/file get saas_action.rsc size] > 10) do={
      :log info "MikroTik SaaS: Executing remote action..."
      /import saas_action.rsc;
    }
    /file remove saas_action.rsc;
  }
}

/system scheduler remove [find name="saas-poll-sched"]
/system scheduler add name="saas-poll-sched" interval=3s on-event="saas-poll"

:delay 2
:log info "MikroTik SaaS: Setup complete!"
:put "Installation complete! Your MikroTik is now connected to SaaS via Agent."
`;
}

module.exports = router;

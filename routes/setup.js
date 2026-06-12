const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SAAS_URL = process.env.SAAS_URL || 'https://mikrotakk-production.up.railway.app';
const DATA_FILE = path.join(__dirname, '..', 'data', 'devices.json');

// Ensure data dir exists
if (!fs.existsSync(path.join(__dirname, '..', 'data'))) {
  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
}

// Simple JSON file storage
function readDevices() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function writeDevices(devices) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(devices, null, 2));
}

// In-memory pending tokens: token → { created, used }
const pendingTokens = new Map();

// ─── Generate a registration token ──────────────────────────────────────────
router.post('/token', (req, res) => {
  const token = crypto.randomBytes(12).toString('hex');
  pendingTokens.set(token, { created: Date.now(), used: false });

  // Expire after 30 minutes
  setTimeout(() => pendingTokens.delete(token), 30 * 60 * 1000);

  const apiUser = 'saas-api';
  const apiPass = crypto.randomBytes(8).toString('hex');

  // Build the RouterOS script inline
  const script = buildScript(token, apiUser, apiPass, SAAS_URL);
  const command = `/tool fetch url="${SAAS_URL}/api/setup/script/${token}" mode=https dst-path=mt_setup.rsc; :delay 3; /import mt_setup.rsc; :do {/file remove mt_setup.rsc} on-error={}`;

  res.json({ success: true, token, command, apiUser, apiPass });
});

// ─── Serve the RouterOS script file ──────────────────────────────────────────
router.get('/script/:token', (req, res) => {
  const { token } = req.params;
  if (!pendingTokens.has(token)) {
    return res.status(404).type('text').send('# Error: Invalid or expired token');
  }

  const apiUser = 'saas-api-' + token.substring(0, 6);
  const apiPass = crypto.createHash('md5').update(token).digest('hex').substring(0, 12);

  res.type('text/plain').send(buildScript(token, apiUser, apiPass, SAAS_URL));
});

// ─── MikroTik calls this after running the script ────────────────────────────
router.post('/register', (req, res) => {
  const { token, identity, model, version, ip, host, apiUser, apiPass, port } = req.body;

  if (!token || !pendingTokens.has(token)) {
    return res.status(401).type('text').send('# Error: Invalid token');
  }

  const tokenData = pendingTokens.get(token);
  if (tokenData.used) {
    return res.status(400).type('text').send('# Error: Token already used');
  }

  // Mark token as used
  tokenData.used = true;
  pendingTokens.set(token, tokenData);

  // Save device
  const devices = readDevices();
  const existing = devices.findIndex(d => d.host === (host || ip));

  const device = {
    id: existing >= 0 ? devices[existing].id : crypto.randomUUID(),
    name: identity || 'MikroTik Router',
    host: host || ip,
    port: parseInt(port) || 8728,
    username: apiUser,
    password: apiPass,
    model: model || '',
    version: version || '',
    identity: identity || '',
    status: 'online',
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  };

  if (existing >= 0) devices[existing] = device;
  else devices.push(device);

  writeDevices(devices);

  console.log(`✅ MikroTik registered: ${identity} (${host || ip})`);
  res.type('text').send(`# Success! ${identity} registered.\n:put "Installation complete!"`);
});

// ─── Get all registered devices ───────────────────────────────────────────────
router.get('/devices', (req, res) => {
  res.json({ success: true, devices: readDevices() });
});

// ─── Delete a device ─────────────────────────────────────────────────────────
router.delete('/devices/:id', (req, res) => {
  let devices = readDevices();
  devices = devices.filter(d => d.id !== req.params.id);
  writeDevices(devices);
  res.json({ success: true });
});

// ─── Check token status (polling) ────────────────────────────────────────────
router.get('/token/:token/status', (req, res) => {
  const t = pendingTokens.get(req.params.token);
  if (!t) return res.json({ status: 'expired' });
  if (t.used) return res.json({ status: 'registered' });
  return res.json({ status: 'pending' });
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
  :put "Error: Could not reach SaaS server"
}

:delay 2
:log info "MikroTik SaaS: Setup complete!"
:put "Installation complete! Your MikroTik is now connected to SaaS."
`;
}

module.exports = router;
module.exports.readDevices = readDevices;

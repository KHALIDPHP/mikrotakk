const RouterOSAPI = require('node-routeros').RouterOSAPI;

class MikroTikAPI {
  constructor(host, port, username, password) {
    this.host = host;
    this.port = port || 8728;
    this.username = username;
    this.password = password;
    this.client = null;
    this.connected = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.client = new RouterOSAPI({
        host: this.host,
        port: this.port,
        user: this.username,
        password: this.password,
        timeout: 10,
      });

      this.client.connect().then(() => {
        this.connected = true;
        resolve(true);
      }).catch((err) => {
        this.connected = false;
        reject(err);
      });
    });
  }

  async disconnect() {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  async getSystemIdentity() {
    const data = await this.client.write('/system/identity/print');
    return data[0] || {};
  }

  async getSystemResource() {
    const data = await this.client.write('/system/resource/print');
    return data[0] || {};
  }

  async getSystemRouterboard() {
    try {
      const data = await this.client.write('/system/routerboard/print');
      return data[0] || {};
    } catch {
      return {};
    }
  }

  async getInterfaces() {
    const data = await this.client.write('/interface/print');
    return data || [];
  }

  async getInterfaceTraffic(interfaces) {
    try {
      const ifaceList = interfaces.map(i => i.name).join(',');
      const data = await this.client.write('/interface/monitor-traffic', [
        `=interface=${ifaceList}`,
        '=once='
      ]);
      return data || [];
    } catch {
      return [];
    }
  }

  async getPPPoEUsers() {
    try {
      const active = await this.client.write('/ppp/active/print');
      const secrets = await this.client.write('/ppp/secret/print');
      return { active: active || [], secrets: secrets || [] };
    } catch {
      return { active: [], secrets: [] };
    }
  }

  async addPPPoEUser(name, password, profile, service, comment) {
    const params = [
      `=name=${name}`,
      `=password=${password}`,
      `=service=${service || 'pppoe'}`,
    ];
    if (profile) params.push(`=profile=${profile}`);
    if (comment) params.push(`=comment=${comment}`);
    
    await this.client.write('/ppp/secret/add', params);
    return true;
  }

  async removePPPoEUser(id) {
    await this.client.write('/ppp/secret/remove', [`=.id=${id}`]);
    return true;
  }

  async disablePPPoEUser(id) {
    await this.client.write('/ppp/secret/disable', [`=.id=${id}`]);
    return true;
  }

  async enablePPPoEUser(id) {
    await this.client.write('/ppp/secret/enable', [`=.id=${id}`]);
    return true;
  }

  async disconnectPPPoEActive(id) {
    await this.client.write('/ppp/active/remove', [`=.id=${id}`]);
    return true;
  }

  async getHotspotUsers() {
    try {
      const users = await this.client.write('/ip/hotspot/user/print');
      const active = await this.client.write('/ip/hotspot/active/print');
      return { users: users || [], active: active || [] };
    } catch {
      return { users: [], active: [] };
    }
  }

  async addHotspotUser(name, password, profile, comment, limitUptime, limitBytes) {
    const params = [
      `=name=${name}`,
      `=password=${password}`,
    ];
    if (profile) params.push(`=profile=${profile}`);
    if (comment) params.push(`=comment=${comment}`);
    if (limitUptime) params.push(`=limit-uptime=${limitUptime}`);
    if (limitBytes) params.push(`=limit-bytes-total=${limitBytes}`);
    
    await this.client.write('/ip/hotspot/user/add', params);
    return true;
  }

  async removeHotspotUser(id) {
    await this.client.write('/ip/hotspot/user/remove', [`=.id=${id}`]);
    return true;
  }

  async getQueues() {
    try {
      const simple = await this.client.write('/queue/simple/print');
      return simple || [];
    } catch {
      return [];
    }
  }

  async addQueue(name, target, maxLimit, comment) {
    await this.client.write('/queue/simple/add', [
      `=name=${name}`,
      `=target=${target}`,
      `=max-limit=${maxLimit}`,
      comment ? `=comment=${comment}` : '',
    ].filter(Boolean));
    return true;
  }

  async removeQueue(id) {
    await this.client.write('/queue/simple/remove', [`=.id=${id}`]);
    return true;
  }

  async setQueueLimit(id, maxLimit) {
    await this.client.write('/queue/simple/set', [
      `=.id=${id}`,
      `=max-limit=${maxLimit}`,
    ]);
    return true;
  }

  async getFirewallRules() {
    try {
      const filter = await this.client.write('/ip/firewall/filter/print');
      const nat = await this.client.write('/ip/firewall/nat/print');
      return { filter: filter || [], nat: nat || [] };
    } catch {
      return { filter: [], nat: [] };
    }
  }

  async getIPPools() {
    try {
      const pools = await this.client.write('/ip/pool/print');
      const used = await this.client.write('/ip/pool/used/print');
      return { pools: pools || [], used: used || [] };
    } catch {
      return { pools: [], used: [] };
    }
  }

  async getIPAddresses() {
    try {
      const data = await this.client.write('/ip/address/print');
      return data || [];
    } catch {
      return [];
    }
  }

  async getPPPoEProfiles() {
    try {
      const data = await this.client.write('/ppp/profile/print');
      return data || [];
    } catch {
      return [];
    }
  }

  async getHotspotProfiles() {
    try {
      const data = await this.client.write('/ip/hotspot/user/profile/print');
      return data || [];
    } catch {
      return [];
    }
  }

  async executeCommand(command, params = []) {
    const data = await this.client.write(command, params);
    return data;
  }
}

// Connection pool to reuse connections
const connectionPool = new Map();

async function getConnection(device) {
  const key = `${device.host}:${device.port}:${device.username}`;
  
  if (connectionPool.has(key)) {
    const conn = connectionPool.get(key);
    if (conn.connected) return conn;
    connectionPool.delete(key);
  }

  const api = new MikroTikAPI(device.host, device.port, device.username, device.password);
  await api.connect();
  connectionPool.set(key, api);
  return api;
}

async function testConnection(host, port, username, password) {
  const api = new MikroTikAPI(host, port, username, password);
  try {
    await api.connect();
    const identity = await api.getSystemIdentity();
    const resource = await api.getSystemResource();
    const rb = await api.getSystemRouterboard();
    await api.disconnect();
    return { 
      success: true, 
      identity: identity.name,
      model: rb.model || resource.board,
      version: resource['version'],
      arch: resource.architecture
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { MikroTikAPI, getConnection, testConnection };

const { getDataStore } = require('../store');
const { currentTenant, runWithTenant } = require('../context');

const list = () => getDataStore().get('devices', []);
const update = change => getDataStore().update('devices', [], change);

module.exports = {
  list,

  add(tenantId, device, checkLimit) {
    return update(async devices => {
      await checkLimit(devices.length);
      return [...devices, device];
    });
  },

  async remove(tenantId, match) {
    const removed = [];
    await update(devices => devices.filter(device => {
      if (!match(device)) return true;
      removed.push(device);
      return false;
    }));
    return removed;
  },

  restore(tenantId, removed) {
    return update(devices => [...devices, ...removed]);
  },

  async update(tenantId, id, changes) {
    let changed = null;
    await update(devices => devices.map(device => {
      if (device.id !== id) return device;
      changed = { ...device, ...changes };
      return changed;
    }));
    return changed;
  },

  async findById(tenantId, id) {
    return (await list()).find(device => device.id === id) || null;
  },

  async findByTokenHash(tenantId, hash) {
    return (await list()).find(device => device.tokenHash === hash) || null;
  },

  async touchMany(touches) {
    const byTenant = new Map();
    for (const { tenantId, deviceId, at } of touches) {
      if (!byTenant.has(tenantId)) byTenant.set(tenantId, new Map());
      const times = byTenant.get(tenantId);
      times.set(deviceId, Math.max(at, times.get(deviceId) ?? at));
    }
    const results = await Promise.allSettled([...byTenant].map(([id, times]) => {
      const tenant = currentTenant();
      return runWithTenant(id === tenant.id ? tenant : { id }, () => update(devices => devices.map(device => {
        const at = times.get(device.id);
        if (at === undefined || Date.parse(device.lastSeen) >= at) return device;
        return { ...device, lastSeen: new Date(at).toISOString() };
      })));
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
};

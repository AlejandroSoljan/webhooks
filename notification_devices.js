'use strict';
const {createHash}=require('node:crypto');
const tokenHash=value=>createHash('sha256').update(value||'').digest('hex');
const canNotify=d=>typeof d.pushToken==='string'&&!!d.pushToken.trim()&&d.notificationInvalidTokenHash!==tokenHash(d.pushToken);

// Installation aliases are linked only by exact identifiers, never by model or IP.
function groupNotificationDevices(rows) {
  const parent = rows.map((_, i) => i), seen = new Map();
  const root = i => parent[i] === i ? i : (parent[i] = root(parent[i]));
  rows.forEach((d, i) => {
    for (const [kind, value] of [['install', d.installId], ['push', d.pushToken], ['device',d.deviceKey], ['verified',d.notificationGroupId]]) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const key = JSON.stringify([d.tenantId, kind, value.trim()]);
      if (seen.has(key)) parent[root(i)] = root(seen.get(key));
      else seen.set(key, i);
    }
  });
  const groups = new Map();
  rows.forEach((d, i) => {
    const key = root(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  });
  const time = d => +new Date(d.updatedAt || d.lastSeenAt || 0) || 0;
  return [...groups.values()].map(group => {
    const members = [...group].sort((a, b) => time(b) - time(a));
    const top = members[0];
    const target = members.find(canNotify) || top;
    return {...top, installId: target.installId, pushToken: canNotify(target)?target.pushToken:null,
      label: members.find(d => d.label)?.label || '',
      installIds: [...new Set(members.map(d => d.installId).filter(Boolean))],
      recordCount: members.length};
  }).sort((a, b) => time(b) - time(a));
}

function publicNotificationDevice(d, activeAfter) {
  return {installId: d.installId, shortId: String(d.installId || '').slice(-10),
    label: d.label, platform: d.platform, deviceName: d.deviceName,
    createdAt: d.createdAt, updatedAt: d.updatedAt, recordCount: d.recordCount,
    active: +new Date(d.updatedAt || 0) >= +activeAfter};
}

module.exports = {groupNotificationDevices, publicNotificationDevice,tokenHash};

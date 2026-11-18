'use strict';

function sensorPath(value) {
  return '/sensors/' + String(value).replace(/^\/sensors\//, '');
}

function selectMotionResources(resources, config) {
  const hue = config.hue || {};
  const explicit = [hue.motionSensorId, ...(Array.isArray(hue.motionSensorIds) ? hue.motionSensorIds : [])]
    .filter(value => typeof value === 'string' && value || typeof value === 'number').map(String);
  const motion = resources.filter(resource => resource.type === 'motion' && resource.id);
  if (explicit.length) {
    const selected = motion.filter(resource => explicit.some(id => resource.id === id || resource.owner?.rid === id || resource.id_v1 === sensorPath(id)));
    // A missing configured sensor makes the aggregate unconfirmed.
    return explicit.every(id => selected.some(resource => resource.id === id || resource.owner?.rid === id || resource.id_v1 === sensorPath(id))) ? selected : [];
  }
  const indoor = config.weather && config.weather.indoorSensorId;
  if (indoor === undefined || indoor === null || indoor === '') return [];
  const owners = new Set(resources.filter(resource => resource.id_v1 === sensorPath(indoor))
    .map(resource => resource.type === 'device' ? resource.id : resource.owner && resource.owner.rid).filter(Boolean));
  if (owners.size !== 1) return [];
  return motion.filter(resource => owners.has(resource.owner && resource.owner.rid));
}

function reading(resource) {
  const data = resource.motion || {};
  const report = data.motion_report;
  const motion = report && typeof report.motion === 'boolean' ? report.motion : data.motion;
  const valid = resource.enabled !== false && data.motion_valid !== false && typeof motion === 'boolean';
  const changedAt = Date.parse(report && report.changed || resource.presenceChangedAt || '');
  return { id: resource.id, motion: valid ? motion : null, changedAt: Number.isFinite(changedAt) ? changedAt : null };
}

function motionPresence(resources) {
  const readings = resources.map(reading).sort((a, b) => a.id.localeCompare(b.id));
  const confirmed = readings.length > 0 && readings.every(item => item.motion !== null);
  return {
    motion: confirmed ? readings.some(item => item.motion) : null,
    online: confirmed, stale: !confirmed, sensorIds: readings.map(item => item.id),
    changedAt: Math.max(0, ...readings.map(item => item.changedAt || 0)) || null,
    signature: confirmed ? JSON.stringify(readings) : null
  };
}

function mergeMotionResource(previous, patch, creationtime) {
  const incoming = { ...previous, ...patch, motion: { ...previous.motion, ...patch.motion } };
  if (patch.motion && patch.motion.motion_report) incoming.motion.motion_report = { ...previous.motion?.motion_report, ...patch.motion.motion_report };
  // Reject old observations received while the initial GET was in flight.
  const currentAt = reading(previous).changedAt;
  const patchAt = Date.parse(patch.motion?.motion_report?.changed || creationtime || '');
  if (currentAt && Number.isFinite(patchAt) && patchAt < currentAt) return previous;
  // Old bridges report only motion.motion. Do not retain an earlier modern value.
  if (patch.motion && typeof patch.motion.motion === 'boolean' && !patch.motion.motion_report) delete incoming.motion.motion_report;
  if (Number.isFinite(patchAt)) incoming.presenceChangedAt = new Date(patchAt).toISOString();
  return incoming;
}

module.exports = { selectMotionResources, motionPresence, mergeMotionResource };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectMotionResources, motionPresence, mergeMotionResource } = require('./presence');

const changed = '2026-11-18T10:00:00Z';
const sensor = (id, owner, motion = false) => ({ id, type: 'motion', id_v1: '/sensors/' + id, owner: { rid: owner }, enabled: true, motion: { motion_report: { motion, changed } } });
const resources = () => [
  { id: 'temperature-living', type: 'temperature', id_v1: '/sensors/23', owner: { rid: 'living-device' } },
  sensor('living-motion', 'living-device'), sensor('bedroom-motion', 'bedroom-device', true)
];

test('presence selects only configured motion resources, including the configured indoor sensor sibling', () => {
  const data = resources();
  assert.deepEqual(selectMotionResources(data, { hue: { motionSensorIds: ['living-motion'] } }).map(item => item.id), ['living-motion']);
  assert.deepEqual(selectMotionResources(data, { hue: { motionSensorId: 'living-device' } }).map(item => item.id), ['living-motion']);
  assert.deepEqual(selectMotionResources(data, { weather: { indoorSensorId: '23' } }).map(item => item.id), ['living-motion']);
  assert.deepEqual(selectMotionResources(data, { weather: { indoorSensorId: '/sensors/23' } }).map(item => item.id), ['living-motion']);
});

test('missing, ambiguous, and absent selectors never adopt unrelated room sensors', () => {
  const data = resources();
  assert.deepEqual(selectMotionResources(data, {}), []);
  assert.deepEqual(selectMotionResources(data, { hue: { motionSensorIds: ['missing'] }, weather: { indoorSensorId: '23' } }), []);
  assert.deepEqual(selectMotionResources(data, { hue: { motionSensorIds: ['living-motion', 'missing'] } }), []);
  assert.deepEqual(selectMotionResources(data, { weather: { indoorSensorId: '404' } }), []);
  data.push({ id: 'another-temperature', type: 'temperature', id_v1: '/sensors/23', owner: { rid: 'bedroom-device' } });
  assert.deepEqual(selectMotionResources(data, { weather: { indoorSensorId: '23' } }), []);
});

test('current presence understands modern and legacy readings and rejects invalid or disabled sensors', () => {
  assert.equal(motionPresence([sensor('modern', 'room', true)]).motion, true);
  const legacy = { id: 'legacy', enabled: true, motion: { motion: false, motion_valid: true } };
  assert.equal(motionPresence([legacy]).motion, false);
  assert.equal(motionPresence([{ ...legacy, enabled: false }]).motion, null);
  assert.equal(motionPresence([{ ...legacy, motion: { motion: false, motion_valid: false } }]).motion, null);
  assert.equal(motionPresence([{ id: 'missing', motion: {} }]).motion, null);
  assert.equal(motionPresence([]).motion, null);
  assert.equal(motionPresence([]).stale, true);
});

test('multiple selected sensors aggregate presence and preserve the observation signature across identical reads', () => {
  const one = sensor('one', 'device', false), two = sensor('two', 'other', true);
  assert.equal(motionPresence([one, two]).motion, true);
  assert.equal(motionPresence([one, { ...two, enabled: false }]).motion, null);
  assert.equal(motionPresence([one, two]).signature, motionPresence([two, structuredClone(one)]).signature);
  const later = structuredClone(one);
  later.motion.motion_report.changed = '2026-11-18T10:01:00Z';
  assert.notEqual(motionPresence([one]).signature, motionPresence([later]).signature);
});

test('a buffered older event cannot replace a newer current-state GET', () => {
  const current = sensor('selected', 'room', true);
  const oldPatch = { id: 'selected', type: 'motion', motion: { motion_report: { motion: false, changed: '2026-11-18T09:59:00Z' } } };
  assert.equal(mergeMotionResource(current, oldPatch, '2026-11-18T09:59:00Z'), current);
  const newer = mergeMotionResource(current, { id: 'selected', motion: { motion_report: { motion: false, changed: '2026-11-18T10:01:00Z' } } });
  assert.equal(motionPresence([newer]).motion, false);
});

test('a legacy live value replaces an earlier modern value and retains a stable replay timestamp', () => {
  const current = sensor('selected', 'room', true);
  const patch = { id: 'selected', motion: { motion: false } };
  const next = mergeMotionResource(current, patch, '2026-11-18T10:01:00Z');
  assert.equal(motionPresence([next]).motion, false);
  const replay = mergeMotionResource(next, patch, '2026-11-18T10:01:00Z');
  assert.equal(motionPresence([next]).signature, motionPresence([replay]).signature);
});

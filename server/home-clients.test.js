'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { HomeClients } = require('./home-clients');

const at = '2026-11-18T10:00:00Z';
const motion = (id, value, changed = at) => ({ id, type: 'motion', enabled: true, owner: { rid: id + '-owner' }, motion: { motion_report: { motion: value, changed } } });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function harness(t, read) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connections = [], events = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    assert.equal(url.pathname, '/eventstream/clip/v2', 'All HTTPS calls are intercepted; no real devices');
    const request = new EventEmitter(); request.destroyed = false;
    request.setTimeout = () => request;
    request.destroy = () => { if (!request.destroyed) { request.destroyed = true; request.emit('close'); } };
    const response = new EventEmitter(); response.statusCode = 200;
    response.setEncoding = () => {}; response.resume = () => {};
    connections.push({ request, response });
    queueMicrotask(() => callback(response));
    return request;
  });
  const client = new HomeClients({ hue: { host: 'bridge.invalid', token: 'mock-token', fingerprint256: '00', motionSensorIds: ['selected'], buttons: { remote: { ids: ['foco-1'] } } } });
  client.readPresenceResources = read;
  t.after(() => client.close());
  client.watchHue(event => events.push(event));
  function send(connection, data, creationtime = at) {
    connection.response.emit('data', 'data: ' + JSON.stringify([{ creationtime, data }]) + '\n\n');
  }
  return { client, connections, events, send };
}

test('Hue stream hydrates current absence at startup and refreshes it after reconnect', async t => {
  let reads = 0;
  const h = harness(t, async () => { reads++; return [motion('selected', false), motion('unrelated-room', true)]; });
  await flush();
  assert.equal(reads, 1);
  assert.equal(h.events.at(-1).motion, false, 'Current absence works without waiting for a future Hue transition');
  assert.deepEqual(h.events.at(-1).sensorIds, ['selected']);
  const initialSignature = h.events.at(-1).signature;
  const count = h.events.length;
  h.send(h.connections[0], [motion('unrelated-room', false)]);
  assert.equal(h.events.length, count, 'Unrelated rooms do not drive the tablet');
  h.send(h.connections[0], [motion('selected', true, '2026-11-18T10:01:00Z')]);
  assert.equal(h.events.at(-1).motion, true, 'Modern live reports update selected presence');
  h.send(h.connections[0], [{ id: 'remote', type: 'button', button: { last_event: 'initial_press' } }]);
  assert.equal(h.events.at(-1).type, 'button');
  assert.deepEqual(h.events.at(-1).ids, ['foco-1'], 'Existing button mapping still works');
  h.connections[0].request.destroy();
  assert.equal(h.events.at(-1).motion, null);
  assert.equal(h.events.at(-1).stale, true);
  t.mock.timers.tick(5000); await flush();
  assert.equal(reads, 2);
  assert.equal(h.connections.length, 2);
  assert.equal(h.events.at(-1).motion, false);
  assert.equal(h.events.at(-1).signature, initialSignature, 'Unchanged read retains its observation identity');
});

test('events buffered during initial GET cannot overwrite a newer sensor observation', async t => {
  let resolveRead;
  const h = harness(t, () => new Promise(resolve => { resolveRead = resolve; }));
  await flush();
  h.send(h.connections[0], [motion('selected', false, '2026-11-18T09:59:00Z')]);
  assert.equal(h.events.length, 0, 'Hydration does not publish an incomplete false assumption');
  resolveRead([motion('selected', true)]); await flush();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].motion, true);
});

test('failed current-state read stays unknown and retries instead of assuming absence', async t => {
  let reads = 0;
  const h = harness(t, async () => {
    if (++reads === 1) throw new Error('Mock Bridge offline');
    return [motion('selected', false)];
  });
  await flush();
  assert.ok(h.events.length > 0);
  assert.ok(h.events.every(event => event.motion === null && event.stale === true));
  assert.equal(h.connections[0].request.destroyed, true);
  t.mock.timers.tick(5000); await flush();
  assert.equal(reads, 2);
  assert.equal(h.events.at(-1).motion, false);
});

test('a missing configured device remains unconfirmed even if another room reports presence', async t => {
  const h = harness(t, async () => [motion('unrelated-room', true)]);
  await flush();
  assert.equal(h.events.at(-1).motion, null);
  assert.equal(h.events.at(-1).online, false);
  const count = h.events.length;
  h.send(h.connections[0], [motion('unrelated-room', false)]);
  assert.equal(h.events.length, count);
});

test('late hydration from a disconnected stream cannot replace reconnect state', async t => {
  let reads = 0, resolveOld;
  const h = harness(t, () => ++reads === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve([motion('selected', false)]));
  await flush(); h.connections[0].request.destroy();
  t.mock.timers.tick(5000); await flush();
  const count = h.events.length;
  assert.equal(h.events.at(-1).motion, false);
  resolveOld([motion('selected', true)]); await flush();
  assert.equal(h.events.length, count);
  assert.equal(h.events.at(-1).motion, false);
});

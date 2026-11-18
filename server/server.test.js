'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./server');

function fixtures() {
  const calls = [];
  let fail = false;
  const robot = {
    call: async method => {
      calls.push(method);
      if (fail) throw new Error('Sem resposta do Saros');
      if (method === 'status') return { state: 8, battery: 100, dockErrorStatus: 38, inCleaning: 0 };
      if (method === 'rooms') return { rooms: { rooms: [{ segmentId: 2 }] }, maps: { mapInfo: [{ rooms: [{ id: 2, iotName: 'Sala' }] }] } };
      return { accepted: true };
    }, close: async () => {}
  };
  const home = { lights: async () => ({ items: [] }), syncState: async () => ({ active: false }), weather: async () => ({}), watchHue: () => {}, close: () => {} };
  return { robot, home, calls, fail: () => { fail = true; } };
}

test('real read failures mark the robot offline and retain the last confirmed tank warning', async () => {
  const values = fixtures();
  const app = createApp({}, { ...values, persist: false });
  await app.refresh.robot();
  values.fail();
  await app.refresh.robot();
  const state = app.snapshot();
  assert.equal(state.robot.online, false);
  assert.equal(state.connections.robot.online, false);
  assert.equal(state.alerts[0].id, 'clean-water-empty');
  assert.equal(state.robot.battery, 100);
  assert.equal(state.robot.location.kind, 'dock');
  assert.equal(state.robot.location.stale, true);
  assert.equal(state.robot.location.updatedAt, state.robot.updatedAt);
  await app.close();
});

test('late room metadata names the current segment without another status read or command', async () => {
  const values = fixtures();
  values.robot.call = async method => {
    values.calls.push(method);
    if (method === 'status') return { state: 6306, cleaning_info: { segment_id: 2, target_segment_id: 3 } };
    if (method === 'rooms') return {
      rooms: { rooms: [{ segmentId: 2 }, { segmentId: 3 }] },
      maps: { mapInfo: [{ rooms: [{ id: 2, iotName: 'Sala de estar' }, { id: 3, iotName: 'Cozinha' }] }] }
    };
    throw new Error('Unexpected actuator request');
  };
  const app = createApp({}, { ...values, persist: false });
  await app.refresh.robot();
  const observedAt = app.snapshot().robot.updatedAt;
  assert.equal(app.snapshot().robot.location.kind, 'unknown');
  await app.refresh.rooms();
  const state = app.snapshot();
  assert.equal(state.robot.location.label, 'Sala de estar');
  assert.equal(state.robot.location.roomId, 2);
  assert.equal(state.robot.targetRoomName, 'Cozinha');
  assert.equal(state.robot.location.updatedAt, observedAt);
  assert.equal(state.robot.currentJob, null);
  assert.deepEqual(values.calls, ['status', 'rooms']);
  await app.close();
});

test('new server state exposes an explicit unconfirmed location', async () => {
  const app = createApp({}, { ...fixtures(), persist: false });
  assert.equal(app.snapshot().robot.location.kind, 'unknown');
  assert.equal(app.snapshot().robot.location.updatedAt, null);
  assert.equal(app.snapshot().robot.location.stale, true);
  await app.close();
});

test('map room metadata uses the parsed segment and can resolve names without refreshing its timestamp', async () => {
  const values = fixtures();
  values.robot.call = async method => {
    values.calls.push(method);
    if (method === 'map') return { imageBase64: Buffer.alloc(24).toString('base64'), width: 100, height: 100, currentRoomId: 2 };
    if (method === 'rooms') return { rooms: { rooms: [{ segmentId: 2 }] }, maps: { mapInfo: [{ rooms: [{ id: 2, iotName: 'Sala' }] }] } };
    throw new Error('Unexpected status or actuator request');
  };
  const app = createApp({}, { ...values, persist: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const first = await (await fetch(baseUrl + '/api/robot/map')).json();
    assert.equal(first.currentRoomId, 2);
    assert.equal(first.currentRoomName, undefined);
    assert.equal(first.currentRoomSource, 'map.vacuum_room');
    assert.ok(Number.isFinite(first.updatedAt));
    await app.refresh.rooms();
    const named = await (await fetch(baseUrl + '/api/robot/map')).json();
    assert.equal(named.currentRoomName, 'Sala');
    assert.equal(named.updatedAt, first.updatedAt);
    assert.deepEqual(values.calls, ['map', 'rooms']);
    assert.equal(app.snapshot().robot.location.kind, 'unknown');
  } finally { await app.close(); }
});

test('map metadata does not turn missing or invalid parser segments into rooms', async () => {
  for (const currentRoomId of [undefined, -1, 0, 2.5, '2']) {
    const values = fixtures();
    values.robot.call = async () => ({ imageBase64: Buffer.alloc(24).toString('base64'), width: 100, height: 100, currentRoomId });
    const app = createApp({}, { ...values, persist: false });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    try {
      const metadata = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/robot/map`)).json();
      assert.equal(metadata.currentRoomId, null);
      assert.equal(metadata.currentRoomName, undefined);
      assert.equal(metadata.currentRoomSource, null);
    } finally { await app.close(); }
  }
});

test('versioned map images stay paired with metadata across refreshes and client cache busters', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const values = fixtures();
  let receivedMaps = 0;
  values.robot.call = async method => {
    values.calls.push(method);
    assert.equal(method, 'map');
    const image = Buffer.alloc(24, ++receivedMaps);
    return { imageBase64: image.toString('base64'), width: 100, height: 100, currentRoomId: receivedMaps };
  };
  const app = createApp({}, { ...values, persist: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const first = await (await fetch(baseUrl + '/api/robot/map')).json();
    assert.equal(new URL(first.imageUrl, baseUrl).searchParams.get('mapVersion'), String(first.updatedAt));
    now += 31000;
    const second = await (await fetch(baseUrl + '/api/robot/map')).json();
    assert.notEqual(second.updatedAt, first.updatedAt);
    const firstImage = await fetch(baseUrl + first.imageUrl + '&v=client-cache-buster&_ambient=another-cache-buster');
    assert.equal(firstImage.status, 200);
    assert.deepEqual(Buffer.from(await firstImage.arrayBuffer()), Buffer.alloc(24, 1));
    const secondImage = await fetch(baseUrl + second.imageUrl);
    assert.deepEqual(Buffer.from(await secondImage.arrayBuffer()), Buffer.alloc(24, 2));
    assert.deepEqual(values.calls, ['map', 'map']);
    now += 31000;
    await fetch(baseUrl + '/api/robot/map');
    const expired = await fetch(baseUrl + first.imageUrl);
    assert.equal(expired.status, 409);
    assert.match((await expired.json()).error, /Volta a carregar/);
    assert.equal(values.calls.length, 3);
    const compatible = await fetch(baseUrl + '/api/robot/map.png?v=old-client');
    assert.equal(compatible.status, 200);
    assert.deepEqual(Buffer.from(await compatible.arrayBuffer()), Buffer.alloc(24, 3));
    assert.equal(values.calls.length, 3);
  } finally { await app.close(); }
});

test('HTTP exposes only public assets and blocks untrusted origins without device commands', async () => {
  const values = fixtures();
  const app = createApp({}, { ...values, persist: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  for (const route of ['/server/config.local.json', '/server/server.js', '/assets/..%2fserver/config.local.json']) {
    const response = await fetch(baseUrl + route);
    assert.equal(response.status, 404);
  }
  const denied = await fetch(baseUrl + '/api/robot/control', { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'denied', action: 'home' }) });
  assert.equal(denied.status, 403);
  const state = await fetch(baseUrl + '/api/state');
  assert.equal(state.status, 200);
  const health = await fetch(baseUrl + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, '2.0.0');
  assert.deepEqual(values.calls, []);
  await app.close();
});

test('current presence initializes unknown and preserves observation revisions across polls and reconnection', async () => {
  const values = fixtures();
  let receive;
  values.home.watchHue = callback => { receive = callback; };
  const app = createApp({}, { ...values, persist: false });
  assert.equal(app.snapshot().presence.motion, null);
  assert.equal(app.snapshot().presence.stale, true);
  app.start();
  const absence = { type: 'presence', motion: false, online: true, stale: false, signature: 'known-sensor:false:100', changedAt: 100, sensorIds: ['known-sensor'] };
  try {
    receive(absence);
    const first = app.snapshot().presence;
    assert.equal(first.motion, false);
    assert.equal(first.stale, false);
    assert.ok(first.revision);
    receive(absence);
    assert.equal(app.snapshot().presence.revision, first.revision, 'Repeated observations do not interrupt manual wake');
    receive({ type: 'presence', motion: null, online: false, stale: true });
    assert.equal(app.snapshot().presence.motion, null, 'A broken stream is unknown, not absence');
    assert.equal(app.snapshot().presence.revision, first.revision);
    receive(absence);
    assert.equal(app.snapshot().presence.revision, first.revision, 'Unchanged reconnect hydration does not replay old absence');
    receive({ ...absence, signature: 'known-sensor:false:200', changedAt: 200 });
    assert.notEqual(app.snapshot().presence.revision, first.revision, 'A newer device observation applies once');
    const second = app.snapshot().presence.revision;
    values.home.lights = async () => { throw new Error('Mock Hue read failure'); };
    await app.refresh.lights();
    assert.equal(app.snapshot().presence.motion, null);
    assert.equal(app.snapshot().presence.online, false);
    assert.equal(app.snapshot().presence.revision, second);
    assert.deepEqual(values.calls.filter(call => !['status', 'rooms'].includes(call)), [], 'Presence never commands a device');
  } finally { await app.close(); }
});

test('a new or reconnected event subscriber receives a current-state notification without replaying motion', async () => {
  const app = createApp({}, { ...fixtures(), persist: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const response = await fetch(baseUrl + '/api/events', { signal: controller.signal });
      const reader = response.body.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.match(first, /data: {"type":"state"}/);
      assert.doesNotMatch(first, /"motion"/);
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  } finally { await app.close(); }
});

test('the same sensor observation keeps its revision across server restarts', async () => {
  const revisions = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const values = fixtures();
    let receive;
    values.home.watchHue = callback => { receive = callback; };
    const app = createApp({}, { ...values, persist: false });
    app.start();
    try {
      receive({ type: 'presence', motion: false, online: true, stale: false, signature: 'same-device:false:100', changedAt: 100, sensorIds: ['same-device'] });
      revisions.push(app.snapshot().presence.revision);
    } finally { await app.close(); }
  }
  assert.equal(revisions[0], revisions[1], 'A restarted server must not replay old absence over manual wake');
});

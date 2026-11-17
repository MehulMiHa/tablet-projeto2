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
  await app.close();
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

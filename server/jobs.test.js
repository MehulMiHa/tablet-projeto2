'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Jobs, validateClean } = require('./jobs');

const rooms = [{ id: 2, name: 'Sala' }];
const base = { online: true, stateCode: 8, inCleaning: 0, alerts: [], errorCode: 0 };
const payload = { requestId: 'request-test-1', vacuumRooms: [2], mopRooms: [], suction: 102, water: 15 };
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('cleaning retry is idempotent and returning to base cannot advance a phase before running', async () => {
  const commands = [];
  const waits = [];
  let status = base;
  const jobs = new Jobs({
    robot: { call: async (_, value) => { commands.push(value); return { accepted: true }; } },
    getStatus: () => status, getRooms: () => rooms,
    sleep: () => { const wait = deferred(); waits.push(wait); return wait.promise; }
  });
  const first = jobs.start({ ...payload, mopRooms: [2] });
  const repeated = jobs.start({ ...payload, mopRooms: [2] });
  assert.equal(first.jobId, repeated.jobId);
  await flush();
  assert.equal(commands.filter(command => command.command === 'app_segment_clean').length, 1);
  assert.equal(jobs.current.status, 'starting');
  assert.deepEqual(commands.find(command => command.command === 'app_segment_clean').params, [{ segments: [2], repeat: 1 }]);
  status = { ...base, stateCode: 18, inCleaning: 1 };
  waits.shift().resolve();
  await flush();
  assert.equal(jobs.current.status, 'running');
  status = base;
  waits.shift().resolve();
  await flush();
  assert.equal(commands.filter(command => command.command === 'app_segment_clean').length, 2);
  jobs.close();
  for (const wait of waits) wait.resolve();
  await flush();
});

test('home during a pending pause15 cancels its future automatic resume', async () => {
  const pause = deferred();
  const sent = [];
  const jobs = new Jobs({
    robot: { call: async (_, value) => {
      sent.push(value.command);
      if (value.command === 'app_pause') await pause.promise;
      return { accepted: true };
    } },
    getStatus: () => base, getRooms: () => rooms
  });
  const pendingPause = jobs.control({ requestId: 'pause-1', action: 'pause15' });
  await jobs.control({ requestId: 'home-1', action: 'home' });
  pause.resolve();
  await pendingPause;
  assert.equal(jobs.timer, null);
  assert.equal(jobs.paused, false);
  assert.deepEqual(sent, ['app_pause', 'app_charge']);
  jobs.close();
});

test('the tank warning does not invent a prohibition on user-requested mopping', () => {
  const jobs = new Jobs({ robot: { call: async () => ({}) }, getStatus: () => ({ ...base, alerts: [{ id: 'clean-water-empty' }] }), getRooms: () => rooms, sleep: () => new Promise(() => {}) });
  assert.equal(jobs.start({ ...payload, vacuumRooms: [], mopRooms: [2] }).ok, true);
  jobs.close();
});

test('persisted active work becomes interrupted and retry cannot restart it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eddy-job-test-'));
  const stateFile = path.join(directory, 'jobs.json');
  const clean = validateClean(payload, rooms);
  fs.writeFileSync(stateFile, JSON.stringify({ current: { id: 'job-original', status: 'running', resumeAt: 123 }, receipts: [[payload.requestId, { signature: JSON.stringify(clean), result: { ok: true, jobId: 'job-original', status: 'accepted' } }]] }));
  let commands = 0;
  const jobs = new Jobs({ robot: { call: () => { commands++; } }, getStatus: () => base, getRooms: () => rooms, stateFile });
  assert.equal(jobs.current.status, 'interrupted');
  assert.equal(jobs.current.resumeAt, null);
  assert.equal(jobs.start(payload).status, 'interrupted');
  assert.equal(commands, 0);
  jobs.close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true });
});

test('invalid/stale selections and duplicate identifiers with changed payload are rejected', () => {
  assert.throws(() => validateClean({ ...payload, vacuumRooms: [99] }, rooms), /mapa atual/);
  assert.throws(() => validateClean({ ...payload, vacuumRooms: [], zones: [[3, 4, 1, 2, 1]], zoneMode: 'vacuum' }, rooms), /limites/);
  const jobs = new Jobs({ robot: { call: async () => ({}) }, getStatus: () => base, getRooms: () => rooms, sleep: () => new Promise(() => {}) });
  jobs.start(payload);
  assert.throws(() => jobs.start({ ...payload, suction: 104 }), /pedido diferente/);
  jobs.close();
});

test('an official-app start between the cached state and execution prevents reconfiguration', async () => {
  let sent = 0;
  const jobs = new Jobs({ robot: { call: async () => { sent++; } }, getStatus: fresh => fresh ? { ...base, stateCode: 18, inCleaning: 1 } : base, getRooms: () => rooms });
  jobs.start(payload);
  await flush();
  assert.equal(sent, 0);
  assert.equal(jobs.current.status, 'failed');
  assert.match(jobs.current.error, /ocupado entretanto/);
  jobs.close();
});

test('a timed pause never restarts a robot that has returned to base', async () => {
  const sent = [];
  const jobs = new Jobs({ robot: { call: async (_, value) => sent.push(value.command) }, getStatus: () => base, getRooms: () => rooms });
  await jobs.control({ requestId: 'pause-test', action: 'pause15' });
  await jobs.resumeAfterPause(jobs.timerVersion);
  assert.deepEqual(sent, ['app_pause']);
  assert.equal(jobs.current.status, 'interrupted');
  assert.equal(jobs.current.resumeAt, null);
  jobs.close();
});

test('pausing preparation resumes only the requested rooms, without a generic app_start', async () => {
  const commands = [];
  const waits = [];
  const jobs = new Jobs({
    robot: { call: async (_, value) => { commands.push(value); return {}; } },
    getStatus: () => base, getRooms: () => rooms,
    sleep: () => { const wait = deferred(); waits.push(wait); return wait.promise; }
  });
  jobs.start(payload);
  await jobs.control({ requestId: 'prepare-pause', action: 'pause' });
  await flush();
  assert.equal(commands.length, 0);
  await jobs.control({ requestId: 'prepare-resume', action: 'resume' });
  waits.shift().resolve();
  await flush();
  assert.equal(commands.filter(value => value.command === 'app_start').length, 0);
  assert.deepEqual(commands.find(value => value.command === 'app_segment_clean').params, [{ segments: [2], repeat: 1 }]);
  jobs.close();
  for (const wait of waits) wait.resolve();
  await flush();
});

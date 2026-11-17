'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { RobotClient } = require('./robot-client');

function childProcess(onRequest) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 1); };
  child.stdin.on('data', buffer => onRequest(JSON.parse(buffer.toString()), child));
  return child;
}

test('a hung Python request times out, kills the child and rejects rather than blocking the queue', async () => {
  let child;
  const client = new RobotClient({ deviceId: 'test-only-device' }, { spawn: () => {
    child = childProcess(() => {});
    return child;
  } });
  await assert.rejects(client.call('status', {}, 10), /não respondeu a tempo/);
  assert.equal(child.killed, true);
  assert.equal(client.pending.size, 0);
  assert.equal(client.child, null);
  await client.close();
});

test('JSON-lines responses correlate IDs and a worker failure never becomes success', async () => {
  const client = new RobotClient({ deviceId: 'test-only-device' }, { spawn: () => childProcess((request, child) => {
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, ok: false, error: 'Sem resposta' }) + '\n'));
  }) });
  await assert.rejects(client.call('status'), /Sem resposta/);
  assert.equal(client.pending.size, 0);
  await client.close();
});

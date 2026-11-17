'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDnsResponse, createQuery } = require('./discovery');

test('reads a compressed PTR service answer after its question', () => {
  const query = createQuery('_huesync._tcp.local');
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  const answer = Buffer.from([0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 120, 0, 6, 3, 66, 111, 120, 0xc0, 12]);
  const packet = Buffer.concat([header, query.subarray(12), answer]);
  assert.deepEqual(parseDnsResponse(packet), [{ name: '_huesync._tcp.local', type: 12, target: 'box._huesync._tcp.local' }]);
});

test('rejects cyclic compression and truncated packets without looping', () => {
  const packet = Buffer.alloc(24);
  packet.writeUInt16BE(1, 6);
  packet[12] = 0xc0;
  packet[13] = 12;
  assert.throws(() => parseDnsResponse(packet), /compression/);
  assert.throws(() => parseDnsResponse(Buffer.alloc(8)), /header/);
});

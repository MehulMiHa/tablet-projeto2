'use strict';

const dgram = require('node:dgram');

function readName(packet, start) {
  const labels = [];
  const visited = new Set();
  let offset = start;
  let end = null;
  while (offset < packet.length) {
    if (visited.has(offset) || visited.size > 128) throw new Error('Invalid DNS compression');
    visited.add(offset);
    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error('Incomplete DNS pointer');
      if (end === null) end = offset + 2;
      offset = ((length & 0x3f) << 8) | packet[offset + 1];
      continue;
    }
    if (length & 0xc0) throw new Error('Invalid DNS label');
    offset += 1;
    if (!length) return { name: labels.join('.'), end: end === null ? offset : end };
    if (offset + length > packet.length) throw new Error('Incomplete DNS label');
    labels.push(packet.toString('utf8', offset, offset + length));
    offset += length;
  }
  throw new Error('Incomplete DNS name');
}

function parseDnsResponse(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12) throw new Error('Incomplete DNS header');
  const questionCount = packet.readUInt16BE(4);
  const count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  if (count > 512 || questionCount > 128) throw new Error('Oversized DNS response');
  let offset = 12;
  for (let index = 0; index < questionCount; index += 1) {
    offset = readName(packet, offset).end + 4;
    if (offset > packet.length) throw new Error('Incomplete DNS question');
  }
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const owner = readName(packet, offset);
    offset = owner.end;
    if (offset + 10 > packet.length) throw new Error('Incomplete DNS record');
    const type = packet.readUInt16BE(offset);
    const length = packet.readUInt16BE(offset + 8);
    const start = offset + 10;
    const end = start + length;
    if (end > packet.length) throw new Error('Incomplete DNS data');
    const record = { name: owner.name.toLowerCase(), type };
    if (type === 1 && length === 4) record.address = [...packet.subarray(start, end)].join('.');
    if (type === 12) record.target = readName(packet, start).name.toLowerCase();
    if (type === 33 && length >= 7) {
      record.port = packet.readUInt16BE(start + 4);
      record.target = readName(packet, start + 6).name.toLowerCase();
    }
    if (type === 16) {
      record.txt = {};
      let position = start;
      while (position < end) {
        const size = packet[position++];
        if (position + size > end) throw new Error('Incomplete DNS TXT record');
        const value = packet.toString('utf8', position, position + size);
        const equals = value.indexOf('=');
        const key = equals === -1 ? value : value.slice(0, equals);
        if (key && key !== '__proto__' && key !== 'constructor') {
          record.txt[key] = equals === -1 ? '' : value.slice(equals + 1);
        }
        position += size;
      }
    }
    records.push(record);
    offset = end;
  }
  return records;
}

function createQuery(service) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  const labels = service.split('.').map(label => {
    const value = Buffer.from(label);
    if (!value.length || value.length > 63) throw new Error('Invalid DNS service');
    return Buffer.concat([Buffer.from([value.length]), value]);
  });
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 12, 0x80, 1])]);
}

function discoverServices(service, { timeoutMs = 3000 } = {}) {
  const normalized = service.replace(/\.$/, '').toLowerCase();
  const query = createQuery(normalized);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const records = [];
    let finished = false;
    let retry;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      try { socket.close(); } catch { /* Socket may fail before binding. */ }
      if (error) return reject(error);
      const instances = new Set(records.filter(record => record.type === 12 && record.name === normalized).map(record => record.target));
      const candidates = new Map();
      for (const record of records) {
        if (record.type !== 33 || (!instances.has(record.name) && !record.name.endsWith('.' + normalized))) continue;
        const address = records.find(item => item.type === 1 && item.name === record.target);
        const txt = records.filter(item => item.type === 16 && item.name === record.name).reduce((value, item) => Object.assign(value, item.txt), {});
        const host = address ? address.address : record.sender;
        if (!host || !record.port) continue;
        candidates.set(`${host}:${record.port}`, { host, port: record.port, name: record.name, txt });
      }
      resolve([...candidates.values()]);
    };
    const deadline = setTimeout(() => finish(), Math.max(100, Math.min(timeoutMs, 10000)));
    socket.on('error', finish);
    socket.on('message', (packet, sender) => {
      try {
        const decoded = parseDnsResponse(packet);
        if (records.length + decoded.length <= 2048) records.push(...decoded.map(record => ({ ...record, sender: sender.address })));
      } catch {
        // Ignore unrelated or incomplete multicast datagrams.
      }
    });
    socket.bind(0, () => {
      if (finished) return;
      try {
        socket.setMulticastTTL(255);
        const send = () => socket.send(query, 5353, '224.0.0.251', error => { if (error) finish(error); });
        send();
        retry = setTimeout(send, Math.min(750, Math.max(50, timeoutMs / 2)));
      } catch (error) {
        finish(error);
      }
    });
  });
}

module.exports = { discoverServices, parseDnsResponse, createQuery };

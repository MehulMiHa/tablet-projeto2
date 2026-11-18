'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createFrameAdminServer } = require('./frame-admin-server');
const { FamilyFiles } = require('./family-files');
const { createApp } = require('./server');

const owner = 'eddy:owner-test-password';
const family = 'familia:family-test-password';
const hash = login => createHash('sha256').update(login).digest('hex');
const credentials = login => `Basic ${Buffer.from(login).toString('base64')}`;
const config = { passwordHash: hash(owner), familyPasswordHash: hash(family) };

async function listen(context, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function dataDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eddy-family-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('family storage survives restart, uses its own directory and protects owner actions', async context => {
  const directory = await dataDirectory(context);
  const panel = createApp({ dataDir: directory, hue: {} }, { home: { close() {} }, robot: { close() {} } });
  const panelOrigin = await listen(context, panel.server);
  const port = panel.server.address().port;
  const gateway = await listen(context, createFrameAdminServer({ config, panelPort: port, familyFiles: panel.familyFiles }));
  const request = (route, login, options = {}) => fetch(gateway + route, {
    ...options, headers: { authorization: credentials(login), ...options.headers }
  });

  assert.equal((await fetch(gateway + '/api/family')).status, 401);
  assert.deepEqual(await (await request('/api/session', owner)).json(), { role: 'owner' });
  assert.deepEqual(await (await request('/api/session', family)).json(), { role: 'family' });
  assert.equal((await request('/api/frame', family)).status, 403);
  assert.equal((await request('/api/frame', owner)).status, 200);
  assert.equal((await fetch(panelOrigin + '/api/family')).status, 404);
  assert.equal((await request('/api/robot/control', family)).status, 404);

  const bytes = Buffer.from('conteúdo <b>tratado como ficheiro</b>');
  const uploadOptions = {
    method: 'POST', body: bytes, headers: {
      'content-type': 'text/html', 'x-file-name': encodeURIComponent('Álbum de férias.html')
    }
  };
  assert.equal((await request('/api/family/files', family, uploadOptions)).status, 403);
  const native = { ...uploadOptions, headers: { ...uploadOptions.headers, 'x-eddy-client': 'android' } };
  const crossSite = { ...native, headers: { ...native.headers, origin: 'http://outside.invalid' } };
  assert.equal((await request('/api/family/files', family, crossSite)).status, 403);
  const upload = await request('/api/family/files', family, native);
  assert.equal(upload.status, 201);
  const listing = await upload.json();
  const [entry] = listing.files;
  assert.equal(listing.canDelete, false);
  assert.equal(listing.totalBytes, bytes.length);
  assert.equal(entry.name, 'Álbum de férias.html');
  assert.equal(entry.type, 'text/html');
  assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
  assert.match(entry.url, /^\/api\/family\/files\/[a-f0-9]{32}$/);
  const { files: [reloaded] } = await new FamilyFiles(path.join(directory, 'family')).list(true);
  assert.deepEqual(reloaded, entry);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['family', 'frame']);

  const ownerListing = await (await request('/api/family', owner)).json();
  assert.equal(ownerListing.canDelete, true);
  const download = await request(entry.url, family);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment; .*filename\*=UTF-8''%C3%81lbum%20de%20f%C3%A9rias\.html$/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

  const deletion = { method: 'DELETE', headers: { origin: gateway } };
  assert.equal((await request(entry.url, family, deletion)).status, 403);
  const removed = await request(entry.url, owner, deletion);
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).files, []);
  assert.equal((await request(entry.url, family)).status, 404);
  assert.deepEqual(await fs.readdir(path.join(directory, 'family')), ['files.json']);
});

test('family upload enforces both declared and streamed limits before committing files', async context => {
  const directory = await dataDirectory(context);
  const store = new FamilyFiles(directory, { maxFileBytes: 16, maxTotalBytes: 24 });
  const gateway = await listen(context, createFrameAdminServer({ config, familyFiles: store }));
  const send = async (size, chunked = false) => {
    const headers = {
      authorization: credentials(family), origin: gateway, 'x-file-name': 'text.txt', 'content-type': 'text/plain'
    };
    if (chunked) headers['transfer-encoding'] = 'chunked';
    else headers['content-length'] = size;
    return new Promise((resolve, reject) => {
      const request = http.request(gateway + '/api/family/files', { method: 'POST', headers }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.write(Buffer.alloc(Math.floor(size / 2), 0x41));
      request.end(Buffer.alloc(Math.ceil(size / 2), 0x42));
    });
  };
  assert.equal(await send(17), 413);
  assert.equal(await send(17, true), 413);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(await send(13), 201);
  assert.equal(await send(13), 409);
  const [entry] = (await store.list(false)).files;
  assert.deepEqual(await fs.readFile(path.join(directory, `${entry.id}.data`)), Buffer.concat([Buffer.alloc(6, 0x41), Buffer.alloc(7, 0x42)]));
});

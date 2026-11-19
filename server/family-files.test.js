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

test('family storage survives restart, uses its own directory and permits shared deletion', async context => {
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
  assert.equal((await request('/api/frame', family)).status, 200);
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
  assert.equal(listing.canDelete, true);
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
  const removed = await request(entry.url, family, deletion);
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).files, []);
  assert.equal((await request(entry.url, family)).status, 404);
  assert.deepEqual(await fs.readdir(path.join(directory, 'family')), ['files.json']);
});

test('owner and family can upload, read and delete each other\'s photos and files without exposing household controls', async context => {
  const directory = await dataDirectory(context);
  const panel = createApp({ dataDir: directory, hue: {} }, { home: { close() {} }, robot: { close() {} } });
  await listen(context, panel.server);
  const gateway = await listen(context, createFrameAdminServer({ config, panelPort: panel.server.address().port, familyFiles: panel.familyFiles }));
  const request = (route, login, options = {}) => fetch(gateway + route, {
    ...options, headers: { authorization: credentials(login), origin: gateway, ...options.headers }
  });
  // Real three-by-two JPEG, including the encoding tables and scan data.
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQ' +
    'ERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU' +
    'FBQUFBQUFBQUFBQUFBT/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA' +
    'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6' +
    'Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
    'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA' +
    'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5' +
    'OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE' +
    'xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8r7y8n1C7nurqeS5uZ3aWWaZy7yOxyzMx' +
    '5JJJJJoooqpbsxo/wo+iP//Z', 'base64'
  );
  for (const [sender, other] of [[owner, family], [family, owner]]) {
    const photoUpload = await request('/api/frame/photos', sender, {
      method: 'POST', body: jpeg, headers: { 'content-type': 'image/jpeg', 'x-photo-name': 'Partilhada.jpg' }
    });
    assert.equal(photoUpload.status, 201);
    const [photo] = (await photoUpload.json()).photos;
    for (const account of [sender, other]) {
      assert.deepEqual(Buffer.from(await (await request(photo.url, account)).arrayBuffer()), jpeg);
      assert.equal((await (await request('/api/frame', account)).json()).photos.length, 1);
    }
    const removedPhoto = await request(photo.url, other, { method: 'DELETE' });
    assert.equal(removedPhoto.status, 200);
    assert.deepEqual((await removedPhoto.json()).photos, []);
    assert.equal((await request(photo.url, sender)).status, 404);

    const bytes = Buffer.from('Ficheiro da família com acesso igual.');
    const fileUpload = await request('/api/family/files', sender, {
      method: 'POST', body: bytes, headers: { 'content-type': 'text/plain', 'x-file-name': 'Partilhado.txt' }
    });
    assert.equal(fileUpload.status, 201);
    const listing = await fileUpload.json();
    assert.equal(listing.canDelete, true);
    const [file] = listing.files;
    assert.deepEqual(Buffer.from(await (await request(file.url, other)).arrayBuffer()), bytes);
    assert.equal((await (await request('/api/family', other)).json()).canDelete, true);
    const removedFile = await request(file.url, other, { method: 'DELETE' });
    assert.equal(removedFile.status, 200);
    assert.deepEqual((await removedFile.json()).files, []);
    assert.equal((await request(file.url, sender)).status, 404);
    for (const route of ['/api/state', '/api/events', '/api/lights/control', '/api/robot/control']) {
      assert.equal((await request(route, sender)).status, 404);
    }
  }
  assert.deepEqual(await fs.readdir(path.join(directory, 'family')), ['files.json']);
  assert.deepEqual(await fs.readdir(path.join(directory, 'frame')), ['album.json']);
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

test('folders migrate old files, preserve bytes through moves, reject cycles and delete only a confirmed subtree', async context => {
  const directory = await dataDirectory(context);
  const id = 'a'.repeat(32);
  await fs.writeFile(path.join(directory, `${id}.data`), 'legacy');
  await fs.writeFile(path.join(directory, 'files.json'), JSON.stringify([{ id, name: 'Antes.txt', size: 6, type: 'text/plain', createdAt: new Date().toISOString() }]));
  const store = new FamilyFiles(directory);
  assert.equal((await store.list(true)).files[0].name, 'Antes.txt');
  const first = (await store.createFolder({ name: 'Férias' })).folders[0];
  const second = (await store.createFolder({ name: 'Vídeos', parentId: first.id })).folders[0];
  await assert.rejects(store.change(first.id, true, { parentId: second.id }), /dentro de si/);
  await assert.rejects(store.createFolder({ name: 'férias' }), /Já existe/);
  const listing = await store.change(id, false, { name: 'Notas.txt', parentId: second.id });
  assert.equal(listing.files[0].name, 'Notas.txt');
  assert.deepEqual(listing.breadcrumbs.map(item => item.name), ['Família', 'Férias', 'Vídeos']);
  assert.deepEqual((await new FamilyFiles(directory).list(true, second.id)).files, listing.files);
  assert.equal(await fs.readFile(path.join(directory, `${id}.data`), 'utf8'), 'legacy');
  await assert.rejects(store.removeFolder(first.id, false), /contém itens/);
  assert.equal((await store.list(true, second.id)).files.length, 1);
  assert.deepEqual((await store.removeFolder(first.id, true)).folders, []);
  await assert.rejects(fs.access(path.join(directory, `${id}.data`)));
  assert.ok((await store.list(true)).effectiveFreeBytes > 0);
});

test('private previews stream byte ranges, support HEAD and never serve HTML inline', async context => {
  const directory = await dataDirectory(context);
  const gateway = await listen(context, createFrameAdminServer({ config, familyFiles: new FamilyFiles(directory) }));
  const headers = { authorization: credentials(family), origin: gateway };
  const bytes = Buffer.from('RIFF0123456789WAVE');
  async function upload(name, type) {
    const response = await fetch(gateway + '/api/family/files', { method: 'POST', headers: { ...headers, 'x-file-name': name, 'content-type': type }, body: bytes });
    assert.equal(response.status, 201);
    return (await response.json()).files.find(item => item.name === name);
  }
  const audio = await upload('Som.wav', 'audio/wav');
  const range = await fetch(gateway + audio.previewUrl, { headers: { ...headers, Range: 'bytes=4-8' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 4-8/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(4, 9));
  const suffix = await fetch(gateway + audio.previewUrl, { headers: { ...headers, Range: 'bytes=-4' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), Buffer.from('WAVE'));
  const head = await fetch(gateway + audio.previewUrl, { method: 'HEAD', headers });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const invalid = await fetch(gateway + audio.previewUrl, { headers: { ...headers, Range: 'bytes=9999-' } });
  assert.equal(invalid.status, 416);
  const html = await upload('Página.html', 'text/html');
  assert.equal(html.previewUrl, null);
  assert.equal((await fetch(gateway + html.url + '/preview', { headers })).status, 415);
  assert.equal((await fetch(gateway + audio.url, { method: 'PATCH', headers: { authorization: credentials(family), 'content-type': 'application/json' }, body: '{"name":"Outro.wav"}' })).status, 403);
  const changed = await fetch(gateway + audio.url, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: '{"name":"Outro.wav"}' });
  assert.equal(changed.status, 200);
});

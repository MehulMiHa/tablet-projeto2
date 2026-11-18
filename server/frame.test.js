'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('./server');
const { MAX_UPLOAD_BYTES } = require('./frame-store');

// Real three-by-two JFIF image produced by a JPEG encoder.
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

async function panel(dataDir) {
  const app = createApp({ dataDir }, {
    persist: false,
    robot: { close: async () => {} },
    home: { close: () => {} },
    frameAdminAddress: () => 'http://100.70.40.20:8787/'
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  return { close: app.close, request: (route, options) => fetch(origin + route, options), origin };
}

function upload(request, bytes, name, mediaType = 'image/jpeg') {
  return request('/api/frame/photos', {
    method: 'POST', body: bytes,
    headers: { 'Content-Type': mediaType, 'X-Photo-Name': encodeURIComponent(name) }
  });
}

test('the frame stores uploads and its setting across panel restarts, and removes deleted photos', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eddy-frame-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = await panel(directory);
  let saved;
  try {
    assert.deepEqual(await (await first.request('/api/frame')).json(), {
      enabled: false, photos: [], revision: 'initial', manageUrl: 'http://100.70.40.20:8787/'
    });
    const eventStream = await first.request('/api/events', { signal: AbortSignal.timeout(3000) });
    const reader = eventStream.body.getReader();
    try {
      const responses = await Promise.all([
        upload(first.request, jpeg, 'Férias de verão.jpg'),
        upload(first.request, jpeg, 'Outra imagem.jpg')
      ]);
      assert.deepEqual(responses.map(item => item.status), [201, 201]);
      let emitted = '';
      while (!emitted.includes('"type":"frame"')) {
        const chunk = await reader.read();
        assert.ok(!chunk.done, 'The panel notified existing subscribers of the upload');
        emitted += Buffer.from(chunk.value).toString('utf8');
      }
    } finally { await reader.cancel(); }
    const response = await first.request('/api/frame/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: first.origin },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(response.status, 200);
    saved = await response.json();
    assert.equal(saved.enabled, true);
    assert.equal(saved.manageUrl, 'http://100.70.40.20:8787/');
    assert.equal(saved.photos.length, 2);
    assert.notEqual(saved.photos[0].id, saved.photos[1].id);
    assert.ok(saved.photos.every(photo => photo.width === 3 && photo.height === 2));
  } finally { await first.close(); }

  const second = await panel(directory);
  try {
    const state = await (await second.request('/api/frame')).json();
    assert.equal(state.enabled, true);
    assert.equal(state.revision, saved.revision);
    const photo = state.photos.find(item => item.name === 'Férias de verão.jpg');
    const image = await second.request(photo.url);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    const removed = await second.request(photo.url, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const remaining = await removed.json();
    assert.equal(remaining.photos.length, 1);
    assert.notEqual(remaining.revision, state.revision);
    assert.equal((await second.request(photo.url)).status, 404);
    assert.equal((await fs.readdir(path.join(directory, 'frame'))).length, 2, 'Only the catalog and remaining photo are on disk');
  } finally { await second.close(); }
});

test('photo requests reject invalid images, oversized uploads, and legacy cross-origin access', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eddy-frame-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { request, close } = await panel(directory);
  try {
    const wrongMime = await upload(request, jpeg, 'foto.png', 'image/png');
    assert.equal(wrongMime.status, 415);
    const truncated = await upload(request, jpeg.subarray(0, jpeg.length - 2), 'recortada.jpg');
    assert.equal(truncated.status, 422);
    const oversized = await upload(request, Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'demasiado-grande.jpg');
    assert.equal(oversized.status, 413);
    const huge = Buffer.from(jpeg);
    const frameOffset = huge.indexOf(Buffer.from([0xff, 0xc0]));
    huge.writeUInt16BE(50_000, frameOffset + 7);
    const dimensions = await upload(request, huge, 'dimensões.jpg');
    assert.equal(dimensions.status, 422);
    const outside = await request('/api/frame', { headers: { Origin: 'https://mehulmiha.github.io' } });
    assert.equal(outside.status, 403);
    assert.equal(outside.headers.get('access-control-allow-origin'), null);
    assert.equal((await (await request('/api/frame')).json()).photos.length, 0);
  } finally { await close(); }
});

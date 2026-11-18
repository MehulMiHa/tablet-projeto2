'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { writeAtomic } = require('./frame-store');
const { ApiError } = require('./jobs');

const DIRECTORY = 'family';
const FILE_ID = /^[a-f0-9]{32}$/;
const FILE_ROUTE = /^\/api\/family\/files\/([a-f0-9]{32})$/;
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 500;
const MIN_FREE_BYTES = 384 * 1024 * 1024;
const MAX_UPLOADS = 2;

function fileName(encoded) {
  let name;
  try {
    if (typeof encoded === 'string') name = decodeURIComponent(encoded).normalize('NFC');
  } catch { /* Invalid encoding is reported as a missing file name. */ }
  if (!name) throw new ApiError('Escolhe um ficheiro com nome.');
  const safe = Array.from(name.replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^[. ]+|[. ]+$/g, ''))
    .slice(0, 180).join('');
  if (!safe) throw new ApiError('Escolhe um ficheiro com nome.');
  return safe;
}

function fileType(value) {
  const type = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
  return type.length <= 120 && MIME_TYPE.test(type) ? type : 'application/octet-stream';
}

function fileMetadata(record) {
  const { id, name, size, type, createdAt } = record;
  return { id, name, size, type, createdAt, url: `/api/family/files/${id}` };
}

function isRecord(record) {
  return record && typeof record.id === 'string' && FILE_ID.test(record.id) &&
    typeof record.name === 'string' && record.name.length > 0 &&
    typeof record.type === 'string' && MIME_TYPE.test(record.type) &&
    Number.isSafeInteger(record.size) && record.size >= 0 &&
    typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt));
}

function storedFile(id) { return `${id}.data`; }
function pendingFile(id) { return `${id}.upload`; }

function disposition(name) {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, symbol => '%' + symbol.charCodeAt(0).toString(16).toUpperCase());
  const fallback = name.replace(/[^ -~]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

class FamilyFiles {
  constructor(directory, { maxFileBytes = MAX_FILE_BYTES, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
    this.directory = directory;
    this.manifest = path.join(directory, 'files.json');
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.records = null;
    this.pending = Promise.resolve();
    this.uploads = 0;
    this.reservedBytes = 0;
  }

  async load() {
    if (this.records) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let contents;
    try { contents = await fs.readFile(this.manifest, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const records = contents === undefined ? [] : JSON.parse(contents);
    if (!Array.isArray(records) || !records.every(isRecord) || new Set(records.map(record => record.id)).size !== records.length) {
      throw new Error('O catálogo da família não está legível.');
    }
    const known = new Set(records.map(record => storedFile(record.id)));
    for (const filename of await fs.readdir(this.directory)) {
      const orphan = /^[a-f0-9]{32}\.data$/.test(filename) && !known.has(filename);
      const unfinished = /^[a-f0-9]{32}\.upload$|^files\.json\.[a-f0-9-]{36}\.tmp$/.test(filename);
      if (orphan || unfinished) await fs.unlink(path.join(this.directory, filename)).catch(() => {});
    }
    this.records = records;
  }

  perform(operation) {
    const next = this.pending.then(async () => {
      await this.load();
      return operation();
    });
    this.pending = next.catch(() => {});
    return next;
  }

  totalBytes() { return this.records.reduce((sum, record) => sum + record.size, 0); }

  snapshot(canDelete) {
    return {
      files: this.records.map(fileMetadata),
      maxFileBytes: this.maxFileBytes,
      maxTotalBytes: this.maxTotalBytes,
      totalBytes: this.totalBytes(),
      canDelete
    };
  }

  list(canDelete) { return this.perform(() => this.snapshot(canDelete)); }

  async save(records) {
    await writeAtomic(this.manifest, JSON.stringify(records));
    this.records = records;
  }

  async reserve(bytes) {
    await this.perform(async () => {
      if (this.uploads >= MAX_UPLOADS) throw new ApiError('Já há ficheiros a chegar. Tenta novamente daqui a pouco.', 429);
      if (this.records.length + this.uploads >= MAX_FILES || this.totalBytes() + this.reservedBytes + bytes > this.maxTotalBytes) {
        throw new ApiError('A pasta da família está cheia.', 409);
      }
      const disk = await fs.statfs(this.directory);
      if (disk.bavail * disk.bsize - this.reservedBytes - bytes < MIN_FREE_BYTES) {
        throw new ApiError('O tablet não tem espaço suficiente para este ficheiro.', 507);
      }
      this.uploads++;
      this.reservedBytes += bytes;
    });
  }

  async upload(request, canDelete) {
    const name = fileName(request.headers['x-file-name']);
    const type = fileType(request.headers['content-type']);
    const contentLength = request.headers['content-length'];
    const expected = contentLength === undefined ? null : Number(contentLength);
    const tooLarge = () => new ApiError(`O ficheiro não pode exceder ${Math.floor(this.maxFileBytes / 1024 / 1024)} MB.`, 413);
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new ApiError('Tamanho de ficheiro inválido.');
    if (expected > this.maxFileBytes) throw tooLarge();
    const reserved = expected ?? this.maxFileBytes;
    await this.reserve(reserved);

    const id = randomBytes(16).toString('hex');
    const temporary = path.join(this.directory, pendingFile(id));
    const target = path.join(this.directory, storedFile(id));
    let size = 0;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > reserved) throw tooLarge();
          await file.writeFile(chunk);
        }
        if (expected !== null && size !== expected) throw new ApiError('O envio do ficheiro ficou incompleto.');
        await file.sync();
      } finally { await file.close(); }
      return await this.perform(async () => {
        await fs.rename(temporary, target);
        const record = { id, name, size, type, createdAt: new Date().toISOString() };
        try { await this.save([record, ...this.records]); }
        catch (error) { await fs.unlink(target).catch(() => {}); throw error; }
        return this.snapshot(canDelete);
      });
    } catch (error) {
      if (error.code === 'ENOSPC') throw new ApiError('O tablet não tem espaço suficiente para este ficheiro.', 507);
      throw error;
    } finally {
      this.reservedBytes -= reserved;
      this.uploads--;
      await fs.unlink(temporary).catch(() => {});
    }
  }

  open(id) {
    return this.perform(async () => {
      const record = this.records.find(item => item.id === id);
      if (!record) throw new ApiError('Ficheiro não encontrado.', 404);
      try { return { record, file: await fs.open(path.join(this.directory, storedFile(id)), 'r') }; }
      catch (error) { if (error.code === 'ENOENT') throw new ApiError('Ficheiro não encontrado.', 404); throw error; }
    });
  }

  remove(id) {
    return this.perform(async () => {
      const records = this.records.filter(record => record.id !== id);
      if (records.length === this.records.length) throw new ApiError('Ficheiro não encontrado.', 404);
      await this.save(records);
      await fs.unlink(path.join(this.directory, storedFile(id))).catch(() => {});
      return this.snapshot(true);
    });
  }
}

function familyRoute(url, method) {
  if (url === '/api/family') return method === 'GET';
  if (url === '/api/family/files') return method === 'POST';
  return FILE_ROUTE.test(url) && (method === 'GET' || method === 'DELETE');
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function serveFamily(request, response, store, canDelete) {
  if (request.url === '/api/family') {
    json(response, 200, await store.list(canDelete));
    return;
  }
  if (request.method === 'POST') {
    json(response, 201, await store.upload(request, canDelete));
    return;
  }
  const id = request.url.match(FILE_ROUTE)[1];
  if (request.method === 'DELETE') {
    if (!canDelete) throw new ApiError('Só o proprietário pode apagar ficheiros.', 403);
    json(response, 200, await store.remove(id));
    return;
  }
  const { record, file } = await store.open(id);
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': record.size,
    'Content-Disposition': disposition(record.name)
  });
  await pipeline(file.createReadStream(), response);
}

module.exports = { DIRECTORY, FamilyFiles, familyRoute, serveFamily };

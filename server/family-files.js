'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { writeAtomic } = require('./frame-store');
const { ApiError } = require('./jobs');

const DIRECTORY = 'family';
const FILE_ID = /^[a-f0-9]{32}$/;
const FILE_ROUTE = /^\/api\/family\/files\/([a-f0-9]{32})(\/preview)?$/;
const FOLDER_ROUTE = /^\/api\/family\/folders\/([a-f0-9]{32})$/;
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024 * 1024;
const MAX_FILES = 10000;
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOADS = 2;
const PREVIEW_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/aac',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'text/plain', 'text/csv', 'text/markdown', 'application/json']);

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
  const { id, name, size, type, createdAt, updatedAt, parentId } = record;
  return { id, name, size, type, createdAt, updatedAt: updatedAt || createdAt, parentId: parentId || null, url: `/api/family/files/${id}`,
    previewUrl: PREVIEW_TYPES.has(type) ? `/api/family/files/${id}/preview` : null };
}

function folderMetadata(record) { return { ...record, url: `/api/family/folders/${record.id}` }; }
function parentId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !FILE_ID.test(value)) throw new ApiError('Pasta inválida.');
  return value;
}
function folderRecord(record) {
  return record && FILE_ID.test(record.id) && typeof record.name === 'string' && record.name.length > 0 &&
    (record.parentId == null || FILE_ID.test(record.parentId)) && Number.isFinite(Date.parse(record.createdAt));
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
    this.folders = [];
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
    const catalogue = contents === undefined ? [] : JSON.parse(contents);
    const records = Array.isArray(catalogue) ? catalogue : catalogue.files;
    const folders = Array.isArray(catalogue) ? [] : catalogue.folders;
    if (!Array.isArray(records) || !records.every(isRecord) || new Set(records.map(record => record.id)).size !== records.length) {
      throw new Error('O catálogo da família não está legível.');
    }
    if (!Array.isArray(folders) || !folders.every(folderRecord) || new Set(folders.map(item => item.id)).size !== folders.length) throw new Error('O catálogo de pastas não está legível.');
    this.folders = folders;
    for (const record of [...records, ...folders]) {
      const visited = new Set([record.id]);
      let id = parentId(record.parentId);
      while (id) {
        const folder = folders.find(item => item.id === id);
        if (!folder || visited.has(id)) throw new Error('O catálogo contém uma pasta inválida.');
        visited.add(id); id = folder.parentId;
      }
    }
    const known = new Set(records.map(record => storedFile(record.id)));
    for (const filename of await fs.readdir(this.directory)) {
      const orphan = /^[a-f0-9]{32}\.data$/.test(filename) && !known.has(filename);
      const unfinished = /^[a-f0-9]{32}\.upload$|^files\.json\.[a-f0-9-]{36}\.tmp$/.test(filename);
      if (orphan || unfinished) await fs.unlink(path.join(this.directory, filename)).catch(() => {});
    }
    this.records = records.map(record => ({ ...record, parentId: record.parentId || null }));
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

  folder(id) {
    id = parentId(id);
    const folder = id && this.folders.find(item => item.id === id);
    if (id && !folder) throw new ApiError('Pasta não encontrada.', 404);
    return folder || null;
  }

  unique(name, parent, except) {
    const key = name.toLocaleLowerCase('pt-PT');
    if ([...this.records, ...this.folders].some(item => item.id !== except && (item.parentId || null) === parent && item.name.toLocaleLowerCase('pt-PT') === key)) {
      throw new ApiError('Já existe um ficheiro ou pasta com esse nome neste local.', 409);
    }
  }

  async snapshot(canDelete, parent = null, committedReservation = 0) {
    const folder = this.folder(parent);
    const breadcrumbs = [];
    for (let current = folder; current; current = this.folder(current.parentId)) breadcrumbs.unshift({ id: current.id, name: current.name });
    breadcrumbs.unshift({ id: null, name: 'Família' });
    const disk = await fs.statfs(this.directory);
    const diskFreeBytes = disk.bavail * disk.bsize;
    const totalBytes = this.totalBytes();
    return {
      files: this.records.filter(item => (item.parentId || null) === parent).map(fileMetadata),
      folders: this.folders.filter(item => (item.parentId || null) === parent).map(folderMetadata),
      currentFolder: folder ? folderMetadata(folder) : null, breadcrumbs,
      maxFileBytes: this.maxFileBytes,
      maxTotalBytes: this.maxTotalBytes,
      totalBytes, diskFreeBytes, diskTotalBytes: disk.blocks * disk.bsize,
      effectiveFreeBytes: Math.max(0, Math.min(this.maxTotalBytes - totalBytes - this.reservedBytes + committedReservation, diskFreeBytes - MIN_FREE_BYTES - this.reservedBytes + committedReservation)),
      canDelete
    };
  }

  list(canDelete, parent = null) { return this.perform(() => this.snapshot(canDelete, parentId(parent))); }

  async save(records, folders = this.folders) {
    await writeAtomic(this.manifest, JSON.stringify({ version: 2, files: records, folders }));
    this.records = records;
    this.folders = folders;
  }

  createFolder(data) {
    return this.perform(async () => {
      const name = fileName(encodeURIComponent(typeof data.name === 'string' ? data.name : ''));
      const parent = parentId(data.parentId); this.folder(parent); this.unique(name, parent);
      if (this.folders.length + this.records.length >= MAX_FILES) throw new ApiError('O limite de itens foi atingido.', 409);
      const stamp = new Date().toISOString();
      await this.save(this.records, [...this.folders, { id: randomBytes(16).toString('hex'), name, parentId: parent, createdAt: stamp, updatedAt: stamp }]);
      return this.snapshot(true, parent);
    });
  }

  change(id, isFolder, data) {
    return this.perform(async () => {
      const items = isFolder ? this.folders : this.records;
      const original = items.find(item => item.id === id);
      if (!original) throw new ApiError('Item não encontrado.', 404);
      const parent = Object.hasOwn(data, 'parentId') ? parentId(data.parentId) : original.parentId || null;
      this.folder(parent);
      if (isFolder) {
        for (let ancestor = parent; ancestor; ancestor = this.folder(ancestor).parentId) {
          if (ancestor === id) throw new ApiError('Uma pasta não pode ser movida para dentro de si própria.');
        }
      }
      const name = Object.hasOwn(data, 'name') ? fileName(encodeURIComponent(typeof data.name === 'string' ? data.name : '')) : original.name;
      this.unique(name, parent, id);
      const changed = items.map(item => item.id === id ? { ...item, name, parentId: parent, updatedAt: new Date().toISOString() } : item);
      await this.save(isFolder ? this.records : changed, isFolder ? changed : this.folders);
      return this.snapshot(true, parent);
    });
  }

  removeFolder(id, recursive) {
    return this.perform(async () => {
      const original = this.folder(id);
      const removed = new Set([id]);
      for (let found = true; found;) {
        found = false;
        for (const folder of this.folders) if (removed.has(folder.parentId) && !removed.has(folder.id)) { removed.add(folder.id); found = true; }
      }
      const files = this.records.filter(item => removed.has(item.parentId));
      if (!recursive && (files.length || removed.size > 1)) throw new ApiError('A pasta contém itens. Confirma a eliminação de todo o conteúdo.', 409);
      await this.save(this.records.filter(item => !removed.has(item.parentId)), this.folders.filter(item => !removed.has(item.id)));
      for (const file of files) await fs.unlink(path.join(this.directory, storedFile(file.id))).catch(() => {});
      return this.snapshot(true, original.parentId || null);
    });
  }

  async reserve(bytes) {
    await this.perform(async () => {
      if (this.uploads >= MAX_UPLOADS) throw new ApiError('Já há ficheiros a chegar. Tenta novamente daqui a pouco.', 429);
      if (this.records.length + this.folders.length + this.uploads >= MAX_FILES || this.totalBytes() + this.reservedBytes + bytes > this.maxTotalBytes) {
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
    const parent = parentId(request.headers['x-folder-id']);
    const contentLength = request.headers['content-length'];
    const expected = contentLength === undefined ? null : Number(contentLength);
    const tooLarge = () => new ApiError(`O ficheiro não pode exceder ${Math.floor(this.maxFileBytes / 1024 / 1024)} MB.`, 413);
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new ApiError('Tamanho de ficheiro inválido.');
    if (expected > this.maxFileBytes) throw tooLarge();
    const reserved = expected ?? this.maxFileBytes;
    await this.perform(() => { this.folder(parent); this.unique(name, parent); });
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
        this.folder(parent); this.unique(name, parent);
        await fs.rename(temporary, target);
        const record = { id, name, size, type, parentId: parent, createdAt: new Date().toISOString() };
        try { await this.save([record, ...this.records]); }
        catch (error) { await fs.unlink(target).catch(() => {}); throw error; }
        return this.snapshot(canDelete, parent, reserved);
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
      const original = this.records.find(record => record.id === id);
      const records = this.records.filter(record => record.id !== id);
      if (records.length === this.records.length) throw new ApiError('Ficheiro não encontrado.', 404);
      await this.save(records);
      await fs.unlink(path.join(this.directory, storedFile(id))).catch(() => {});
      return this.snapshot(true, original.parentId || null);
    });
  }
}

function familyRoute(url, method) {
  const parsed = new URL(url, 'http://localhost');
  if (parsed.pathname === '/api/family') return method === 'GET' && [...parsed.searchParams.keys()].every(key => key === 'parent');
  if (parsed.pathname === '/api/family/files' || parsed.pathname === '/api/family/folders') return method === 'POST' && !parsed.search;
  if (FOLDER_ROUTE.test(parsed.pathname)) return (method === 'PATCH' || method === 'DELETE') && [...parsed.searchParams.keys()].every(key => key === 'recursive');
  const file = parsed.pathname.match(FILE_ROUTE);
  return !!file && !parsed.search && (file[2] ? ['GET', 'HEAD'].includes(method) : ['GET', 'HEAD', 'DELETE', 'PATCH'].includes(method));
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function serveFamily(request, response, store, canDelete) {
  const parsed = new URL(request.url, 'http://localhost');
  if (parsed.pathname === '/api/family') {
    json(response, 200, await store.list(canDelete, parsed.searchParams.get('parent')));
    return;
  }
  if (request.method === 'POST' && parsed.pathname === '/api/family/files') {
    json(response, 201, await store.upload(request, canDelete));
    return;
  }
  async function body() {
    let value = '';
    for await (const chunk of request) { value += chunk; if (Buffer.byteLength(value) > 4096) throw new ApiError('Pedido demasiado grande.', 413); }
    try { const data = JSON.parse(value); if (data && typeof data === 'object' && !Array.isArray(data)) return data; } catch { /* Report malformed JSON. */ }
    throw new ApiError('Pedido inválido.');
  }
  if (parsed.pathname === '/api/family/folders') { json(response, 201, await store.createFolder(await body())); return; }
  const folder = parsed.pathname.match(FOLDER_ROUTE);
  const fileMatch = parsed.pathname.match(FILE_ROUTE);
  const id = (folder || fileMatch)[1];
  if (request.method === 'PATCH') { json(response, 200, await store.change(id, !!folder, await body())); return; }
  if (request.method === 'DELETE') {
    if (!canDelete) throw new ApiError('Este acesso não pode apagar ficheiros.', 403);
    json(response, 200, folder ? await store.removeFolder(id, parsed.searchParams.get('recursive') === 'true') : await store.remove(id));
    return;
  }
  const { record, file } = await store.open(id);
  try {
    const preview = !!fileMatch[2];
    if (preview && !PREVIEW_TYPES.has(record.type)) throw new ApiError('Guarda este formato para o abrir noutra aplicação.', 415);
    let start = 0, end = record.size - 1, partial = false;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || !record.size || (!match[1] && !match[2])) {
        response.setHeader('Content-Range', `bytes */${record.size}`); throw new ApiError('Intervalo inválido.', 416);
      }
      if (match[1]) { start = Number(match[1]); end = match[2] ? Number(match[2]) : end; }
      else start = Math.max(0, record.size - Number(match[2]));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= record.size || Number(match[2]) === 0 && !match[1]) {
        response.setHeader('Content-Range', `bytes */${record.size}`); throw new ApiError('Intervalo inválido.', 416);
      }
      end = Math.min(end, record.size - 1); partial = true;
    }
    const headers = { 'Content-Type': preview ? record.type : 'application/octet-stream',
      'Content-Length': record.size ? end - start + 1 : 0, 'Accept-Ranges': 'bytes',
      'Content-Disposition': preview ? 'inline' : disposition(record.name) };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${record.size}`;
    response.writeHead(partial ? 206 : 200, headers);
    if (request.method === 'HEAD' || !record.size) response.end();
    else await pipeline(file.createReadStream({ start, end, autoClose: false }), response);
  } finally { await file.close().catch(() => {}); }
}

module.exports = { DIRECTORY, FamilyFiles, familyRoute, serveFamily };

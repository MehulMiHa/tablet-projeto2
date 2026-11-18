'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { ApiError } = require('./jobs');

const PHOTO_ID = /^[0-9a-f]{32}$/;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS = 300;
const MAX_ALBUM_BYTES = 512 * 1024 * 1024;
const EMPTY_STATE = { enabled: false, photos: [], revision: 'initial' };

function jpegSize(image) {
  const invalid = () => new ApiError('A fotografia JPEG está incompleta ou não é válida.', 422);
  if (image.length < 4 || image.readUInt16BE(0) !== 0xffd8) throw invalid();
  let offset = 2;
  let size = null;
  let quantization = false;
  let huffman = false;
  let scanned = false;
  while (offset < image.length) {
    if (image[offset++] !== 0xff) throw invalid();
    while (image[offset] === 0xff) offset++;
    const marker = image[offset++];
    if (marker === 0xd9) {
      if (size && scanned && offset === image.length) return size;
      throw invalid();
    }
    if (offset + 2 > image.length) throw invalid();
    const length = image.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > image.length) throw invalid();

    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size || length < 8 || image[offset + 2] !== 8) throw invalid();
      const height = image.readUInt16BE(offset + 3);
      const width = image.readUInt16BE(offset + 5);
      const components = image[offset + 7];
      if (!width || !height || ![1, 3, 4].includes(components) || length !== 8 + 3 * components) throw invalid();
      if (width > 4096 || height > 4096 || width * height > 16_000_000) {
        throw new ApiError('A fotografia excede a resolução máxima. Reduz o tamanho e volta a enviar.', 422);
      }
      size = { width, height };
    } else if (marker === 0xdb) {
      if (length < 67) throw invalid();
      quantization = true;
    } else if (marker === 0xc4) {
      if (length < 20) throw invalid();
      huffman = true;
    } else if (marker === 0xda) {
      if (!size || !quantization || !huffman || length < 8) throw invalid();
      const scanComponents = image[offset + 2];
      if (scanComponents < 1 || scanComponents > 4 || length !== 6 + 2 * scanComponents) throw invalid();
      // Entropy-coded bytes use FF00 for an escaped FF and may contain restart markers.
      offset = end;
      let hasData = false;
      for (;;) {
        const next = image.indexOf(0xff, offset);
        if (next === -1) throw invalid();
        hasData = hasData || next > offset || image[next + 1] === 0;
        const following = image[next + 1];
        if (following === 0 || (following >= 0xd0 && following <= 0xd7)) {
          offset = next + 2;
        } else {
          if (!hasData) throw invalid();
          offset = next;
          break;
        }
      }
      scanned = true;
      continue;
    } else if (marker !== 0xdd && marker !== 0xfe && !(marker >= 0xe0 && marker <= 0xef)) {
      throw invalid();
    }
    offset = end;
  }
  throw invalid();
}

function photoName(encoded) {
  let name = '';
  if (typeof encoded === 'string') {
    try { name = decodeURIComponent(encoded).normalize('NFC'); } catch { /* Missing or invalid upload label. */ }
  }
  const safe = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return Array.from(safe).slice(0, 120).join('') || 'Fotografia';
}

async function uploadImage(request) {
  const mime = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (mime !== 'image/jpeg') throw new ApiError('Envia a fotografia em formato JPEG.', 415);
  const tooLarge = () => new ApiError('A fotografia não pode exceder 8 MB.', 413);
  if (Number(request.headers['content-length']) > MAX_UPLOAD_BYTES) throw tooLarge();
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > MAX_UPLOAD_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function writeAtomic(filename, data) {
  const pending = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(pending, 'wx', 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally { await file.close(); }
    await fs.rename(pending, filename);
  } catch (error) {
    await fs.unlink(pending).catch(() => {});
    throw error;
  }
}

class FrameStore {
  constructor(directory) {
    this.directory = directory;
    this.manifest = path.join(directory, 'album.json');
    this.state = null;
    this.pending = Promise.resolve();
  }

  imagePath(id) { return path.join(this.directory, `${id}.jpg`); }

  async load() {
    if (this.state) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let contents;
    try { contents = await fs.readFile(this.manifest, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const state = contents === undefined ? EMPTY_STATE : JSON.parse(contents);
    if (!state || typeof state.enabled !== 'boolean' || typeof state.revision !== 'string' ||
        !Array.isArray(state.photos) || state.photos.some(photo => !photo || !PHOTO_ID.test(photo.id) ||
          typeof photo.name !== 'string' || !Number.isInteger(photo.bytes) || photo.bytes < 1)) {
      throw new Error('O catálogo da moldura não está legível.');
    }
    const photos = new Set(state.photos.map(photo => `${photo.id}.jpg`));
    // A restart between image and catalog updates can leave an unused image or temporary file.
    for (const filename of await fs.readdir(this.directory)) {
      const orphan = /^[0-9a-f]{32}\.jpg$/.test(filename) && !photos.has(filename);
      const temporary = /^(?:album\.json|[0-9a-f]{32}\.jpg)\.[0-9a-f-]{36}\.tmp$/.test(filename);
      if (orphan || temporary) await fs.unlink(path.join(this.directory, filename)).catch(() => {});
    }
    this.state = state;
  }

  perform(operation) {
    const next = this.pending.then(async () => {
      await this.load();
      return operation();
    });
    this.pending = next.catch(() => {});
    return next;
  }

  snapshot() {
    const { enabled, revision, photos } = this.state;
    return {
      enabled, revision,
      photos: photos.map(({ id, name, width, height }) => ({ id, name, width, height, url: `/api/frame/photos/${id}` }))
    };
  }

  async save(changes) {
    const state = { ...this.state, ...changes, revision: randomUUID() };
    await writeAtomic(this.manifest, JSON.stringify(state));
    this.state = state;
    return this.snapshot();
  }

  list() { return this.perform(() => this.snapshot()); }

  setEnabled(enabled) {
    return this.perform(() => this.state.enabled === enabled ? this.snapshot() : this.save({ enabled }));
  }

  add(image, encodedName) {
    const size = jpegSize(image);
    return this.perform(async () => {
      const { photos } = this.state;
      const bytes = photos.reduce((total, photo) => total + photo.bytes, image.length);
      if (photos.length >= MAX_PHOTOS || bytes > MAX_ALBUM_BYTES) {
        throw new ApiError('O álbum está cheio. Apaga algumas fotografias antes de adicionar outras.', 409);
      }
      const id = randomBytes(16).toString('hex');
      const file = this.imagePath(id);
      await writeAtomic(file, image);
      try {
        return await this.save({ photos: [...photos, { id, name: photoName(encodedName), bytes: image.length, ...size }] });
      } catch (error) {
        await fs.unlink(file).catch(() => {});
        throw error;
      }
    });
  }

  remove(id) {
    return this.perform(async () => {
      const photos = this.state.photos.filter(photo => photo.id !== id);
      if (photos.length === this.state.photos.length) throw new ApiError('Fotografia não encontrada.', 404);
      const result = await this.save({ photos });
      // The catalog is authoritative; a deleted photo can no longer be served even if unlink fails.
      await fs.unlink(this.imagePath(id)).catch(() => {});
      return result;
    });
  }

  open(id) {
    return this.perform(async () => {
      const photo = this.state.photos.find(item => item.id === id);
      if (!photo) throw new ApiError('Fotografia não encontrada.', 404);
      try { return await fs.open(this.imagePath(id), 'r'); }
      catch (error) { if (error.code === 'ENOENT') throw new ApiError('Fotografia não encontrada.', 404); throw error; }
    });
  }
}

module.exports = { FrameStore, PHOTO_ID, MAX_UPLOAD_BYTES, uploadImage, writeAtomic };

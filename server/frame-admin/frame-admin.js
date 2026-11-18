'use strict';

const byId = id => document.getElementById(id);
const albumGrid = byId('albumGrid');
const filePicker = byId('filePicker');
const addPhotos = byId('addPhotos');
const preview = byId('preview');
const previewImage = byId('previewImage');
const removePhoto = byId('removePhoto');
const maxSourceBytes = 32 * 1024 * 1024;
const targetBytes = 2 * 1024 * 1024;
let frame = null;
let selectedPhoto = null;
let busy = false;

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.method === 'POST' ? 60000 : 15000);
  try {
    const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = data && (data.message || data.error);
      throw new Error(typeof detail === 'string' ? detail : 'O tablet não aceitou o pedido.');
    }
    if (!data || !Array.isArray(data.photos)) throw new Error('A resposta do tablet está incompleta.');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('O tablet demorou demasiado a responder.');
    if (error instanceof TypeError) throw new Error('Perdeu-se a ligação ao tablet.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function showMessage(text) {
  const element = byId('activity');
  element.textContent = text;
  element.hidden = !text;
}

function showProblem(text, files = [], retry = false) {
  const list = byId('problemFiles');
  list.replaceChildren();
  for (const detail of files) {
    const item = document.createElement('li');
    item.textContent = detail;
    list.append(item);
  }
  list.hidden = !files.length;
  byId('problemText').textContent = text;
  byId('reload').hidden = !retry;
  byId('problems').hidden = !text;
}

function setBusy(value) {
  busy = value;
  addPhotos.disabled = value || !frame;
  removePhoto.disabled = value;
  byId('reload').disabled = value;
}

function render() {
  const status = byId('frameStatus');
  status.hidden = !frame;
  if (!frame) return;
  status.textContent = frame.enabled ? 'Ativa no tablet' : 'Desligada no tablet';
  status.classList.toggle('is-on', frame.enabled);
  const photos = frame.photos.filter(photo => photo && /^[0-9a-f]{32}$/.test(photo.id) && photo.url === `/api/frame/photos/${photo.id}`);
  const count = byId('photoCount');
  count.textContent = `${photos.length} ${photos.length === 1 ? 'foto' : 'fotos'}`;
  count.hidden = false;
  byId('empty').hidden = photos.length !== 0;
  const cards = document.createDocumentFragment();
  for (const photo of photos) {
    const card = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'photo';
    button.type = 'button';
    button.addEventListener('click', () => openPreview(photo));
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = photo.url;
    const label = document.createElement('span');
    label.textContent = photo.name;
    button.append(image, label);
    card.append(button);
    cards.append(card);
  }
  albumGrid.replaceChildren(cards);
}

async function loadFrame() {
  setBusy(true);
  byId('loading').hidden = !!frame;
  showProblem('');
  try {
    frame = await request('/api/frame');
    render();
  } catch (error) {
    showProblem(error.message, [], true);
  } finally {
    byId('loading').hidden = true;
    setBusy(false);
  }
}

function openPreview(photo) {
  selectedPhoto = photo;
  byId('previewTitle').textContent = photo.name;
  previewImage.alt = photo.name;
  previewImage.src = photo.url;
  if (typeof preview.showModal === 'function') preview.showModal();
  else preview.setAttribute('open', '');
}

function closePreview() {
  if (typeof preview.close === 'function') preview.close();
  else preview.removeAttribute('open');
  clearPreview();
}

function clearPreview() {
  selectedPhoto = null;
  previewImage.removeAttribute('src');
}

function encodeJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob && blob.type === 'image/jpeg') resolve(blob);
      else reject(new Error('Não foi possível preparar a foto em JPG.'));
    }, 'image/jpeg', quality);
  });
}

async function preparePhoto(file) {
  if (file.size > maxSourceBytes) throw new Error('Escolhe uma cópia com menos de 32 MB.');
  const url = URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement('canvas');
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('O navegador não abriu este formato. Experimenta uma cópia JPG ou PNG.'));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('A fotografia está danificada.');
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('O navegador não conseguiu preparar esta fotografia.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const jpeg = await encodeJpeg(canvas, 0.86);
    return jpeg.size <= targetBytes ? jpeg : await encodeJpeg(canvas, 0.72);
  } finally {
    URL.revokeObjectURL(url);
    image.removeAttribute('src');
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function addFiles(files) {
  if (busy || !frame || !files.length) return;
  setBusy(true);
  showProblem('');
  const failures = [];
  let sent = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    try {
      showMessage(`A preparar foto ${index + 1} de ${files.length}…`);
      const jpeg = await preparePhoto(file);
      showMessage(`A enviar foto ${index + 1} de ${files.length}…`);
      frame = await request('/api/frame/photos', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Name': encodeURIComponent(file.name) },
        body: jpeg
      });
      sent++;
    } catch (error) {
      failures.push(`${file.name} — ${error.message}`);
    }
  }
  // A dropped response can leave a successfully uploaded photo on the tablet.
  if (failures.length) {
    try { frame = await request('/api/frame'); } catch { /* Keep the last confirmed album. */ }
    showProblem('Confirma as fotos na lista antes de repetir o envio.', failures);
  }
  render();
  showMessage(sent ? (sent === 1 ? '1 foto enviada.' : `${sent} fotos enviadas.`) : '');
  setBusy(false);
}

async function deleteSelected() {
  if (busy || !selectedPhoto) return;
  const photo = selectedPhoto;
  if (!window.confirm(`Apagar a cópia de «${photo.name}» que está no tablet?`)) return;
  closePreview();
  setBusy(true);
  showProblem('');
  showMessage('A apagar a foto…');
  try {
    frame = await request(photo.url, { method: 'DELETE' });
    showMessage('Foto apagada.');
  } catch (error) {
    showMessage('');
    showProblem(error.message, [], true);
  } finally {
    render();
    setBusy(false);
    addPhotos.focus();
  }
}

addPhotos.addEventListener('click', () => filePicker.click());
filePicker.addEventListener('change', () => {
  const files = Array.from(filePicker.files);
  filePicker.value = '';
  addFiles(files);
});
byId('reload').addEventListener('click', loadFrame);
byId('closePreview').addEventListener('click', closePreview);
preview.addEventListener('close', () => { if (!preview.open) clearPreview(); });
removePhoto.addEventListener('click', deleteSelected);
loadFrame();

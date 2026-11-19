'use strict';

const byId = id => document.getElementById(id);
const photoId = /^[a-f0-9]{32}$/;
const views = {
  photos: { panel: 'photoView', picker: 'filePicker', add: 'addPhotos', placeholder: 'photoPlaceholder', path: '/api/frame', itemPath: '/api/frame/photos', list: 'photos', nameHeader: 'X-Photo-Name', data: null, busy: false },
  family: { panel: 'familyView', picker: 'familyPicker', add: 'addFiles', placeholder: 'familyPlaceholder', path: '/api/family', itemPath: '/api/family/files', list: 'files', nameHeader: 'X-File-Name', data: null, busy: false }
};
const dialog = byId('preview');
const previewImage = byId('previewImage');
const previewText = byId('previewText');
const previewDownload = byId('downloadItem');
const units = ['B', 'KB', 'MB', 'GB'];
const decimal = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 1 });
const dates = new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'short', year: 'numeric' });
const safeImages = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const safeText = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json']);
const maxSourceBytes = 32 * 1024 * 1024;
const previewTextBytes = 512 * 1024;
const previewImageBytes = 16 * 1024 * 1024;
let role = '';
let active = 'photos';
let mutation = false;
let connectionPending = false;
let selection = null;
let previewController = null;
let previewUrl = null;
let dismissNotice = 0;
let familyParent = null;
let familyGeneration = 0;
let moveGeneration = 0;
let moveParent = null;
let nameMode = '';
let uploadRequest = null;
let uploadCancelled = false;
const mediaVideo = byId('previewVideo');
const mediaAudio = byId('previewAudio');

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#icon-' + name);
  svg.append(use);
  return svg;
}

function prettySize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index++;
  }
  return decimal.format(bytes) + ' ' + units[index];
}

function prettyDate(value) {
  const stamp = new Date(value);
  return Number.isNaN(stamp.getTime()) ? '' : dates.format(stamp);
}

function setNetwork(status) {
  document.body.dataset.network = status;
  const labels = { connecting: 'A ligar…', online: role === 'family' ? 'Acesso Família' : 'Ligado ao tablet', offline: 'Sem ligação' };
  const element = byId('connectionStatus');
  if (element.textContent !== labels[status]) element.textContent = labels[status];
}

async function request(path, options = {}) {
  const { timeout = 15000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = new Headers(fetchOptions.headers);
    if (typeof window.EddyMobile?.authorization === 'function') headers.set('Authorization', window.EddyMobile.authorization());
    if (typeof window.EddyMobile?.tunnelHeader === 'function') headers.set('X-Eddy-Tunnel-Key', window.EddyMobile.tunnelHeader());
    if (fetchOptions.method && window.EddyMobile) headers.set('X-Eddy-Client', 'android');
    const response = await fetch(path, {
      ...fetchOptions, headers, cache: 'no-store', credentials: 'same-origin', signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) throw new Error('Volta a iniciar sessão para aceder ao Eddy.');
      const detail = data && (data.message || data.error);
      throw new Error(typeof detail === 'string' ? detail : 'O tablet não aceitou o pedido.');
    }
    if (!data || typeof data !== 'object') throw new Error('A resposta do tablet está incompleta.');
    setNetwork('online');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      setNetwork('offline');
      throw new Error('A ligação demorou demasiado. Atualiza a lista antes de repetir.');
    }
    if (error instanceof TypeError) {
      setNetwork('offline');
      throw new Error('Perdeu-se a ligação ao tablet. Confirma o Tailscale e tenta novamente.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function notice(message, tone = 'info', failures = []) {
  clearTimeout(dismissNotice);
  const box = byId('notice');
  const files = byId('noticeFiles');
  box.hidden = !message;
  box.dataset.tone = tone;
  byId('noticeMessage').textContent = message;
  files.replaceChildren();
  files.hidden = !failures.length;
  for (const failure of failures) {
    const row = document.createElement('li');
    row.textContent = failure;
    files.append(row);
  }
  if (message && tone !== 'error') dismissNotice = setTimeout(() => { box.hidden = true; }, 4500);
}

function progress(message, position, total) {
  const meter = byId('transferProgress');
  const box = byId('transfer');
  box.hidden = !message;
  byId('transferTitle').textContent = message;
  meter.max = Math.max(1, total || 0);
  meter.value = position || 0;
}

function updateControls() {
  for (const [name, view] of Object.entries(views)) {
    byId(view.add).disabled = mutation || !view.data;
    const reload = document.querySelector('[data-reload="' + name + '"]');
    reload.disabled = mutation || view.busy || connectionPending;
  }
  byId('removeItem').disabled = mutation;
  byId('confirmRemove').disabled = mutation;
  byId('newFolder').disabled = mutation || !views.family.data;
  byId('saveName').disabled = mutation;
  byId('renameItem').disabled = mutation;
  byId('moveItem').disabled = mutation;
}

function goodItems(data, view) {
  if (!Array.isArray(data[view.list])) throw new Error('A resposta do tablet está incompleta.');
  return data[view.list].filter(item => item && photoId.test(item.id) && typeof item.name === 'string' && item.url === view.itemPath + '/' + item.id);
}

function accept(name, data) {
  const view = views[name];
  view.data = { ...data, [view.list]: goodItems(data, view) };
  if (name === 'family') view.data.folders = Array.isArray(data.folders) ? data.folders.filter(item => photoId.test(item.id) && typeof item.name === 'string' && item.url === '/api/family/folders/' + item.id) : [];
  render(name);
}

function setPlaceholder(name, text) {
  const node = byId(views[name].placeholder);
  node.hidden = !text;
  node.textContent = text;
}

function count(label, singular, plural, size) {
  const element = byId(label);
  element.textContent = size + ' ' + (size === 1 ? singular : plural);
  element.hidden = false;
}

function renderPhotos() {
  const data = views.photos.data;
  if (!data) return;
  byId('frameStatus').textContent = data.enabled ? 'Moldura ligada no tablet' : 'Moldura desligada no tablet';
  count('photoCount', 'foto', 'fotos', data.photos.length);
  setPlaceholder('photos', data.photos.length ? '' : 'Adiciona as primeiras fotos para a moldura.');
  const fragment = document.createDocumentFragment();
  for (const photo of data.photos.slice().reverse()) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const img = document.createElement('img');
    const label = document.createElement('span');
    button.className = 'photo';
    button.type = 'button';
    button.addEventListener('click', () => openDetail('photos', photo));
    img.className = 'photo-image';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = photo.url;
    label.className = 'photo-name';
    label.textContent = photo.name;
    button.append(img, label);
    item.append(button);
    fragment.append(item);
  }
  byId('albumGrid').replaceChildren(fragment);
}

function fileKind(file) {
  if (file.type?.startsWith('video/')) return 'video';
  if (file.type?.startsWith('audio/')) return 'audio';
  if (safeImages.has(file.type)) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  if (/\.(zip|rar|7z|gz)$/i.test(file.name)) return 'archive';
  return 'other';
}

function searchKey(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-PT');
}

function folderPath(id) { return '/api/family' + (id ? '?parent=' + encodeURIComponent(id) : ''); }

function breadcrumbs(element, items, select) {
  element.hidden = false;
  element.replaceChildren();
  for (const [index, item] of items.entries()) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = item.name;
    button.setAttribute('aria-current', index === items.length - 1 ? 'location' : 'false');
    button.addEventListener('click', () => select(item.id)); element.append(button);
    if (index < items.length - 1) element.append(icon('chevron'));
  }
}

function navigateFolder(id) {
  if (mutation || id === familyParent && views.family.data) return;
  closeDetail(); familyGeneration++; familyParent = id; views.family.busy = false; views.family.data = null;
  byId('familySearch').value = ''; byId('familyList').replaceChildren(); setPlaceholder('family', 'A abrir pasta…');
  load('family');
}

function sendFile(path, body, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); uploadRequest = xhr;
    xhr.open('POST', path); xhr.timeout = 2 * 60 * 60 * 1000;
    xhr.withCredentials = true;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    if (typeof window.EddyMobile?.authorization === 'function') xhr.setRequestHeader('Authorization', window.EddyMobile.authorization());
    if (typeof window.EddyMobile?.tunnelHeader === 'function') xhr.setRequestHeader('X-Eddy-Tunnel-Key', window.EddyMobile.tunnelHeader());
    if (window.EddyMobile) xhr.setRequestHeader('X-Eddy-Client', 'android');
    xhr.upload.onprogress = event => onProgress(event.loaded, event.lengthComputable ? event.total : body.size);
    byId('cancelUpload').hidden = false;
    xhr.onload = () => {
      let data; try { data = JSON.parse(xhr.responseText); } catch { /* Incomplete response. */ }
      if (xhr.status < 200 || xhr.status >= 300 || !data) reject(new Error(data?.error || 'O envio não foi confirmado. Atualiza a pasta antes de repetir.'));
      else { setNetwork('online'); resolve(data); }
    };
    xhr.onerror = () => { setNetwork('offline'); reject(new Error('A ligação caiu. Os ficheiros completos já enviados foram mantidos.')); };
    xhr.ontimeout = () => reject(new Error('O envio demorou demasiado. Confirma a ligação e volta a tentar.'));
    xhr.onabort = () => reject(new Error('Envio cancelado.'));
    xhr.send(body);
  });
}

function namePanel(mode) {
  if (mutation) return;
  nameMode = mode;
  byId('previewActions').hidden = true; byId('removeConfirmation').hidden = true; byId('movePanel').hidden = true;
  byId('nameForm').hidden = false; byId('nameError').hidden = true;
  byId('itemName').value = mode === 'new' ? '' : selection.item.name;
  byId('itemName').focus(); byId('itemName').select();
}

function newFolder() {
  if (mutation || !views.family.data) return;
  resetPreviewMedia(); selection = null; byId('previewTitle').textContent = 'Nova pasta'; byId('previewMeta').hidden = true;
  namePanel('new'); dialog.showModal();
}

async function submitName(event) {
  event.preventDefault();
  if (mutation) return;
  const name = byId('itemName').value.trim(); if (!name) return;
  mutation = true; updateControls(); byId('nameError').hidden = true;
  try {
    const data = await request(nameMode === 'new' ? '/api/family/folders' : selection.item.url, {
      method: nameMode === 'new' ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ...(nameMode === 'new' ? { parentId: familyParent } : {}) })
    });
    accept('family', data); closeDetail(); notice(nameMode === 'new' ? 'Pasta criada.' : 'Nome atualizado.');
  } catch (error) { byId('nameError').textContent = error.message; byId('nameError').hidden = false; }
  finally { mutation = false; updateControls(); }
}

async function chooseMoveFolder(id) {
  const generation = ++moveGeneration; moveParent = id;
  byId('confirmMove').disabled = true; byId('moveError').hidden = true;
  byId('moveStatus').textContent = 'A abrir pasta…'; byId('moveFolders').replaceChildren();
  try {
    const data = await request(folderPath(id));
    if (generation !== moveGeneration || !selection) return;
    breadcrumbs(byId('moveBreadcrumbs'), data.breadcrumbs, chooseMoveFolder);
    const folders = data.folders.filter(item => item.id !== selection.item.id);
    for (const folder of folders) {
      const row = document.createElement('li'); const button = document.createElement('button'); button.type = 'button'; button.className = 'file';
      const title = document.createElement('span'); title.textContent = folder.name;
      button.append(icon('folder'), title, icon('chevron')); button.addEventListener('click', () => chooseMoveFolder(folder.id));
      row.append(button); byId('moveFolders').append(row);
    }
    byId('moveStatus').textContent = folders.length ? 'Abre uma pasta ou escolhe este local.' : 'Podes mover para esta pasta.';
    byId('confirmMove').disabled = mutation || (selection.item.parentId || null) === id || selection.item.id === id;
  } catch (error) { if (generation === moveGeneration) { byId('moveError').textContent = error.message; byId('moveError').hidden = false; } }
}

function openMove() {
  if (!selection || mutation) return;
  resetPreviewMedia(); byId('nameForm').hidden = true; byId('removeConfirmation').hidden = true;
  byId('previewActions').hidden = true; byId('movePanel').hidden = false;
  chooseMoveFolder(null);
}

async function confirmMove() {
  if (!selection || mutation) return;
  mutation = true; updateControls(); byId('confirmMove').disabled = true;
  try {
    await request(selection.item.url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentId: moveParent }) });
    closeDetail(); mutation = false; await load('family'); notice('Item movido.');
  } catch (error) { byId('moveError').textContent = error.message; byId('moveError').hidden = false; }
  finally { mutation = false; updateControls(); byId('confirmMove').disabled = false; }
}

function renderFamily() {
  const data = views.family.data;
  if (!data) return;
  const { files, folders = [] } = data;
  const all = [...folders.map(item => ({ ...item, folder: true })), ...files];
  const query = searchKey(byId('familySearch').value.trim());
  const filtered = query ? all.filter(file => searchKey(file.name).includes(query)) : all;
  count('familyCount', 'item', 'itens', all.length);
  const capacity = [prettySize(data.totalBytes), prettySize(data.maxTotalBytes)];
  byId('familyVolume').textContent = capacity.every(Boolean) ? capacity.join(' de ') + ' usados no tablet' : 'Ficheiros partilhados no tablet';
  const ratio = data.maxTotalBytes > 0 ? Math.min(100, data.totalBytes / data.maxTotalBytes * 100) : 0;
  byId('familyStorage').hidden = false;
  byId('storagePercent').textContent = ratio > 0 && ratio < .1 ? '<0,1% usado' : decimal.format(ratio) + '% usado';
  byId('storageProgress').value = ratio;
  byId('storageDetail').textContent = prettySize(data.totalBytes) + ' de ' + prettySize(data.maxTotalBytes) + ' · ' + prettySize(data.effectiveFreeBytes ?? Math.max(0, data.maxTotalBytes - data.totalBytes)) + ' disponíveis';
  byId('folderBack').hidden = !familyParent;
  byId('folderTitle').firstChild.textContent = (data.currentFolder?.name || 'Ficheiros') + ' ';
  breadcrumbs(byId('familyBreadcrumbs'), data.breadcrumbs || [{ id: null, name: 'Família' }], navigateFolder);
  byId('searchWrap').hidden = all.length < 2 && !query;
  setPlaceholder('family', !all.length ? 'Esta pasta está vazia. Adiciona ficheiros ou cria uma pasta.' : filtered.length ? '' : 'Nenhum item corresponde à pesquisa.');
  const fragment = document.createDocumentFragment();
  for (const file of filtered.slice().sort((a, b) => Number(!!b.folder) - Number(!!a.folder) || a.name.localeCompare(b.name, 'pt-PT', { numeric: true }))) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const badge = document.createElement('span');
    const labels = document.createElement('span');
    const title = document.createElement('strong');
    const metadata = document.createElement('span');
    const kind = file.folder ? 'folder' : fileKind(file);
    button.type = 'button';
    button.className = 'file';
    button.addEventListener('click', () => file.folder ? navigateFolder(file.id) : openDetail('family', file));
    badge.className = 'file-icon';
    badge.dataset.kind = kind;
    badge.append(icon(kind === 'image' ? 'frame' : ['archive', 'folder', 'audio', 'video'].includes(kind) ? kind : 'file'));
    labels.className = 'file-label';
    title.textContent = file.name;
    metadata.className = 'file-meta';
    metadata.textContent = file.folder ? 'Pasta' : [prettySize(file.size), prettyDate(file.createdAt)].filter(Boolean).join(' · ');
    labels.append(title, metadata);
    button.append(badge, labels, icon('chevron'));
    item.append(button);
    if (file.folder) {
      item.className = 'folder-row';
      const more = document.createElement('button'); more.type = 'button'; more.className = 'icon-button folder-more';
      more.setAttribute('aria-label', 'Opções da pasta ' + file.name); more.append(icon('more'));
      more.addEventListener('click', () => openDetail('family', file)); item.append(more);
    }
    fragment.append(item);
  }
  byId('familyList').replaceChildren(fragment);
}

function render(name) {
  if (name === 'photos') renderPhotos();
  else renderFamily();
  updateControls();
}

async function load(name) {
  const view = views[name];
  if (view.busy || mutation || !role) return;
  view.busy = true;
  if (!view.data) setPlaceholder(name, 'A carregar…');
  updateControls();
  const generation = name === 'family' ? ++familyGeneration : 0;
  try {
    const data = await request(name === 'family' ? folderPath(familyParent) : view.path);
    if (name === 'family' && generation !== familyGeneration) return;
    accept(name, data);
  } catch (error) {
    if (name === 'family' && generation !== familyGeneration) return;
    if (!view.data) setPlaceholder(name, 'Não foi possível carregar. Toca no botão de atualizar.');
    notice(error.message, 'error');
  } finally {
    if (name !== 'family' || generation === familyGeneration) view.busy = false;
    updateControls();
  }
}

function selectView(view, moveScroll = true) {
  if (!views[view]) return;
  active = view;
  document.body.dataset.section = view;
  for (const [name, item] of Object.entries(views)) {
    byId(item.panel).hidden = name !== view;
    const tab = document.querySelector('[data-view="' + name + '"]');
    if (name === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (moveScroll) window.scrollTo(0, 0);
  if (!views[view].data) load(view);
}

async function connect() {
  if (connectionPending) return;
  connectionPending = true;
  setNetwork('connecting');
  updateControls();
  try {
    const result = await request('/api/session');
    if (!['owner', 'family'].includes(result.role)) throw new Error('O tablet não confirmou o teu acesso.');
    role = result.role;
    document.body.dataset.role = role;
    setNetwork('online');
    selectView(active, false);
  } catch (error) {
    setNetwork('offline');
    setPlaceholder(active, 'Toca no botão de atualizar para tentar novamente.');
    notice(error.message, 'error');
  } finally {
    connectionPending = false;
    updateControls();
  }
}

function resetPreviewMedia() {
  for (const media of [mediaVideo, mediaAudio]) { media.pause(); media.removeAttribute('src'); media.load(); media.hidden = true; }
  if (previewController) previewController.abort();
  previewController = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  previewImage.removeAttribute('src');
  previewImage.hidden = true;
  previewText.textContent = '';
  previewText.hidden = true;
  byId('previewMessage').hidden = true;
  byId('previewVisual').hidden = true;
}

function showPreviewMessage(message) {
  byId('previewVisual').hidden = false;
  const element = byId('previewMessage');
  element.hidden = !message;
  element.textContent = message;
}

async function previewAttachment(file) {
  if (file.previewUrl && /^(video|audio)\//.test(file.type)) {
    const media = file.type.startsWith('video/') ? mediaVideo : mediaAudio;
    media.hidden = false; byId('previewVisual').hidden = false;
    media.onerror = () => showPreviewMessage('Este formato não é reproduzido neste telemóvel. Podes guardar o ficheiro para o abrir noutra app.');
    media.src = file.previewUrl;
    return;
  }
  const image = safeImages.has(file.type) && file.size <= previewImageBytes;
  const text = safeText.has(file.type) && file.size <= previewTextBytes;
  if (!image && !text) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  previewController = controller;
  showPreviewMessage('A abrir pré-visualização…');
  try {
    const headers = new Headers();
    if (typeof window.EddyMobile?.authorization === 'function') headers.set('Authorization', window.EddyMobile.authorization());
    if (typeof window.EddyMobile?.tunnelHeader === 'function') headers.set('X-Eddy-Tunnel-Key', window.EddyMobile.tunnelHeader());
    const reply = await fetch(file.url, { headers, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
    if (!reply.ok) throw new Error('O tablet não devolveu o ficheiro.');
    const attachment = await reply.blob();
    if (!selection || selection.item !== file || previewController !== controller) return;
    if (image) {
      if (attachment.size > previewImageBytes) throw new Error('Imagem demasiado grande.');
      previewUrl = URL.createObjectURL(new Blob([attachment], { type: file.type }));
      previewImage.onload = () => showPreviewMessage('');
      previewImage.onerror = () => {
        previewImage.hidden = true;
        showPreviewMessage('Guarda o ficheiro para o abrir no telemóvel.');
      };
      previewImage.alt = file.name;
      previewImage.hidden = false;
      previewImage.src = previewUrl;
    } else {
      if (attachment.size > previewTextBytes) throw new Error('Texto demasiado grande.');
      const value = await attachment.text();
      if (previewController !== controller) return;
      previewText.textContent = value;
      previewText.hidden = false;
      showPreviewMessage('');
    }
  } catch {
    if (previewController === controller) showPreviewMessage('Guarda o ficheiro para o abrir no telemóvel.');
  } finally {
    clearTimeout(timer);
  }
}

function confirmation(show) {
  byId('nameForm').hidden = true; byId('movePanel').hidden = true;
  byId('removeConfirmation').hidden = !show;
  byId('previewActions').hidden = show;
  if (show) {
    byId('removeDetail').textContent = selection.item.name + (selection.item.folder ? ' — a pasta e todos os ficheiros e subpastas serão apagados.' : '');
    byId('cancelRemove').focus();
  } else if (dialog.open && !byId('removeItem').hidden) {
    byId('removeItem').focus();
  }
}

function openDetail(area, item) {
  resetPreviewMedia();
  selection = { area, item };
  nameMode = ''; moveGeneration++;
  byId('previewTitle').textContent = item.name;
  const meta = byId('previewMeta');
  meta.textContent = area === 'family' ? [prettySize(item.size), prettyDate(item.createdAt)].filter(Boolean).join(' · ') : '';
  meta.hidden = !meta.textContent;
  byId('removeItem').hidden = !role || (area === 'family' && !views.family.data.canDelete);
  byId('renameItem').hidden = byId('moveItem').hidden = area !== 'family';
  previewDownload.hidden = area !== 'family' || !!item.folder;
  if (area === 'family') {
    previewDownload.href = item.url;
    previewDownload.download = item.name;
  } else {
    previewDownload.removeAttribute('href');
    previewImage.onload = null;
    previewImage.onerror = () => {
      previewImage.hidden = true;
      showPreviewMessage('Não foi possível abrir esta foto.');
    };
    previewImage.alt = item.name;
    previewImage.hidden = false;
    byId('previewVisual').hidden = false;
    previewImage.src = item.url;
  }
  confirmation(false);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  if (area === 'family' && !item.folder) previewAttachment(item);
}

function clearDetail() {
  moveGeneration++;
  selection = null;
  previewImage.onload = null;
  previewImage.onerror = null;
  resetPreviewMedia();
}

function closeDetail() {
  if (!dialog.open) return false;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  clearDetail();
  return true;
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
      image.onerror = () => reject(new Error('O navegador não abriu este formato. Experimenta JPG ou PNG.'));
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
    const jpeg = await encodeJpeg(canvas, .86);
    return jpeg.size <= 2 * 1024 * 1024 ? jpeg : await encodeJpeg(canvas, .72);
  } finally {
    URL.revokeObjectURL(url);
    image.removeAttribute('src');
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function addItems(area, files) {
  const view = views[area];
  if (mutation || !view.data || !files.length) return;
  mutation = true;
  // The native app keeps its private tunnel connected until the complete upload batch settles.
  try { window.EddyMobile?.uploadState?.(true); } catch { /* Browser clients have no native lifecycle. */ }
  uploadCancelled = false;
  const uploadParent = familyParent;
  updateControls();
  notice('');
  const failures = [];
  let sent = 0;
  try {
    for (const [index, file] of files.entries()) {
      if (uploadCancelled) break;
      try {
        if (area === 'family' && file.size > view.data.maxFileBytes) {
          throw new Error('O limite por ficheiro é ' + prettySize(view.data.maxFileBytes) + '.');
        }
        if (area === 'photos') progress('A preparar foto ' + (index + 1) + ' de ' + files.length, index, files.length);
        const body = area === 'photos' ? await preparePhoto(file) : file;
        if (uploadCancelled) break;
        progress('A enviar ' + (index + 1) + ' de ' + files.length + ' · ' + file.name, index, files.length);
        const data = await sendFile(view.itemPath, body, { 'Content-Type': body.type || 'application/octet-stream', [view.nameHeader]: encodeURIComponent(file.name), ...(area === 'family' && uploadParent ? { 'X-Folder-Id': uploadParent } : {}) }, (loaded, total) => progress('A enviar ' + file.name + ' · ' + prettySize(loaded) + ' de ' + prettySize(total), loaded, total));
        accept(area, data);
        sent++;
      } catch (error) {
        failures.push(file.name + ' — ' + error.message);
      }
    }
    if (failures.length) {
      try { accept(area, await request(area === 'family' ? folderPath(uploadParent) : view.path)); } catch { /* Keep the confirmed entries. */ }
      notice(sent ? sent + ' enviados. Revê os restantes.' : 'O envio precisa de atenção.', 'error', failures);
    } else {
      const label = area === 'photos' ? (sent === 1 ? 'Foto enviada.' : sent + ' fotos enviadas.') : (sent === 1 ? 'Ficheiro enviado.' : sent + ' ficheiros enviados.');
      notice(uploadCancelled ? 'Envio cancelado. Os ficheiros já enviados foram mantidos.' : label);
    }
    render(area);
  } finally {
    progress('');
    uploadRequest = null; byId('cancelUpload').hidden = true;
    mutation = false;
    try { window.EddyMobile?.uploadState?.(false); } catch { /* The native page may already be closing. */ }
    updateControls();
  }
}

async function deleteItem() {
  if (!selection || !role || mutation) return;
  const { area, item } = selection;
  if (area === 'family' && !views.family.data.canDelete) return;
  closeDetail();
  mutation = true;
  updateControls();
  notice('');
  try {
    accept(area, await request(item.url + (item.folder ? '?recursive=true' : ''), { method: 'DELETE' }));
    notice(item.folder ? 'Pasta apagada.' : area === 'photos' ? 'Foto apagada.' : 'Ficheiro apagado.');
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    mutation = false;
    updateControls();
  }
}

for (const [name, view] of Object.entries(views)) {
  byId(view.add).addEventListener('click', () => byId(view.picker).click());
  byId(view.picker).addEventListener('change', event => {
    const files = Array.from(event.target.files);
    event.target.value = '';
    addItems(name, files);
  });
  document.querySelector('[data-view="' + name + '"]').addEventListener('click', () => selectView(name));
  document.querySelector('[data-reload="' + name + '"]').addEventListener('click', () => {
    notice('');
    if (!role) connect();
    else load(name);
  });
}

byId('familySearch').addEventListener('input', renderFamily);
byId('newFolder').addEventListener('click', newFolder);
byId('folderBack').addEventListener('click', () => navigateFolder(views.family.data?.currentFolder?.parentId || null));
byId('nameForm').addEventListener('submit', submitName);
byId('renameItem').addEventListener('click', () => namePanel('rename'));
byId('cancelName').addEventListener('click', () => selection ? confirmation(false) : closeDetail());
byId('moveItem').addEventListener('click', openMove);
byId('cancelMove').addEventListener('click', () => { moveGeneration++; confirmation(false); });
byId('confirmMove').addEventListener('click', confirmMove);
byId('cancelUpload').addEventListener('click', () => { uploadCancelled = true; uploadRequest?.abort(); });
byId('closePreview').addEventListener('click', closeDetail);
dialog.addEventListener('close', () => { if (!dialog.open) clearDetail(); });
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDetail();
});
byId('removeItem').addEventListener('click', () => { if (selection && !mutation) confirmation(true); });
byId('cancelRemove').addEventListener('click', () => confirmation(false));
byId('confirmRemove').addEventListener('click', deleteItem);
previewDownload.addEventListener('click', event => {
  if (!selection || selection.area !== 'family' || typeof window.EddyMobile?.download !== 'function') return;
  event.preventDefault();
  window.EddyMobile.download(selection.item.url, selection.item.name);
});
window.EddyCloseOverlay = () => {
  if (dialog.open && (!byId('nameForm').hidden || !byId('movePanel').hidden || !byId('removeConfirmation').hidden) && selection) { confirmation(false); return true; }
  if (closeDetail()) return true;
  if (active === 'family' && familyParent && !mutation) { navigateFolder(views.family.data?.currentFolder?.parentId || null); return true; }
  return false;
};
if (typeof window.EddyMobile?.changeConnection === 'function') {
  const settings = byId('connectionSettings');
  settings.setAttribute('aria-label', 'Voltar a ligar ao tablet');
  settings.setAttribute('title', 'Voltar a ligar');
  settings.hidden = false;
  settings.addEventListener('click', () => window.EddyMobile.changeConnection());
}
window.addEventListener('online', () => { if (!role) connect(); else load(active); });
window.addEventListener('offline', () => setNetwork('offline'));
window.addEventListener('pagehide', () => { uploadCancelled = true; uploadRequest?.abort(); resetPreviewMedia(); });
connect();

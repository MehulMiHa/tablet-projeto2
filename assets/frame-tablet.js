(function () {
  'use strict';

  var idleDelay = 30000;
  var slideDelay = 30000;
  var reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  var options;
  var elements;
  var album = null;
  var context = { awake: false, canPlay: false };
  var nextRefresh = true;
  var loading = false;
  var saving = false;
  var error = '';
  var idleSince = Date.now();
  var timer = null;
  var imageTimeout = null;
  var pendingImage = null;
  var currentImage = null;
  var outgoingImage = null;
  var fade = null;
  var cursor = 0;

  function safeManageAddress(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      var address = new URL(value);
      return /^https?:$/.test(address.protocol) && !address.username && !address.password && !address.search && !address.hash ? address.href : '';
    } catch (ignored) { return ''; }
  }

  function setAlbum(data, keepAddress) {
    if (!data || typeof data.enabled !== 'boolean' || !Array.isArray(data.photos)) throw new Error('O painel devolveu um álbum inválido.');
    var photos = data.photos.filter(function (photo) {
      return photo && /^[a-f0-9]{32}$/.test(photo.id) && photo.url === '/api/frame/photos/' + photo.id;
    });
    var address = keepAddress && album && data.manageUrl === undefined ? album.address : safeManageAddress(data.manageUrl);
    album = { enabled: data.enabled, photos: photos, revision: data.revision, address: address };
    if (currentImage) {
      var currentIndex = photos.findIndex(function (photo) { return photo.id === currentImage.dataset.photoId; });
      if (currentIndex === -1) stop();
      else cursor = currentIndex + 1;
    }
    if (pendingImage && !photos.some(function (photo) { return photo.id === pendingImage.dataset.photoId; })) stop();
    if (currentImage && photos.length > 1 && timer === null) schedule(slideDelay, nextPhoto);
  }

  function renderSettings() {
    var enabled = !!(album && album.enabled);
    var count = album ? album.photos.length : 0;
    elements.toggle.disabled = !album || loading || saving;
    elements.toggle.setAttribute('aria-checked', String(enabled));
    elements.switchVisual.classList.toggle('is-on', enabled);
    var label = count === 1 ? '1 foto no tablet' : count + ' fotos no tablet';
    if (!count) label = 'Ainda não há fotos no tablet';
    if (loading && !album) label = 'A abrir o álbum…';
    if (saving) label = 'A guardar…';
    if (error) label = error;
    if (elements.status.textContent !== label) elements.status.textContent = label;
    elements.status.classList.toggle('is-error', !!error);
    elements.retry.hidden = !error || saving || loading;
    var address = album ? album.address : '';
    elements.address.textContent = address;
    elements.address.hidden = !address;
  }

  async function refresh() {
    if (!options || !context.awake || !nextRefresh || loading || saving) return;
    nextRefresh = false;
    loading = true;
    error = '';
    renderSettings();
    try {
      setAlbum(await options.request('/api/frame'));
    } catch (failure) {
      error = failure.message || 'Não foi possível abrir o álbum.';
    } finally {
      loading = false;
      renderSettings();
      planIdle();
      if (nextRefresh) refresh();
    }
  }

  function invalidate(revision) {
    if (album && revision !== undefined && revision === album.revision) return;
    nextRefresh = true;
    refresh();
  }

  async function toggle() {
    if (!album || saving || loading) return;
    saving = true;
    error = '';
    renderSettings();
    try {
      setAlbum(await options.request('/api/frame/settings', { method: 'PUT', body: { enabled: !album.enabled } }), true);
    } catch (failure) {
      error = failure.message || 'Não foi possível guardar a definição.';
    } finally {
      saving = false;
      renderSettings();
      planIdle();
      if (nextRefresh) refresh();
    }
  }

  function canPlay() {
    return context.awake && context.canPlay && album && album.enabled && album.photos.length > 0;
  }

  function schedule(delay, callback) {
    clearTimeout(timer);
    timer = setTimeout(function () { timer = null; callback(); }, delay);
  }

  function release(image) {
    if (!image) return;
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
    image.remove();
  }

  function clearFade() {
    if (fade) fade.cancel();
    fade = null;
    release(outgoingImage);
    outgoingImage = null;
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
    clearTimeout(imageTimeout);
    clearFade();
    release(pendingImage);
    release(currentImage);
    pendingImage = null;
    currentImage = null;
    elements.slide.hidden = true;
  }

  function dismiss() {
    if (!currentImage) return false;
    stop();
    noteActivity();
    return true;
  }

  function display(image) {
    clearFade();
    var previous = currentImage;
    currentImage = image;
    image.hidden = false;
    elements.slide.hidden = false;
    if (previous && !reducedMotion.matches && typeof image.animate === 'function') {
      outgoingImage = previous;
      fade = image.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 480, easing: 'ease-in-out' });
      fade.onfinish = clearFade;
    } else release(previous);
  }

  function nextPhoto() {
    if (!canPlay() || pendingImage) return;
    var photos = album.photos;
    if (currentImage && photos.length === 1) return;
    var index = cursor % photos.length;
    if (currentImage && photos[index].id === currentImage.dataset.photoId) index = (index + 1) % photos.length;
    var photo = photos[index];
    cursor = index + 1;

    var image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.hidden = true;
    image.dataset.photoId = photo.id;
    pendingImage = image;
    function finish(success) {
      if (pendingImage !== image) return;
      clearTimeout(imageTimeout);
      image.onload = null;
      image.onerror = null;
      pendingImage = null;
      if (!canPlay()) { release(image); return; }
      if (success) display(image);
      else release(image);
      if (!currentImage || album.photos.length > 1) schedule(slideDelay, nextPhoto);
    }
    image.onload = function () { finish(true); };
    image.onerror = function () { finish(false); };
    imageTimeout = setTimeout(function () { finish(false); }, 8000);
    elements.slide.appendChild(image);
    image.src = new URL(photo.url, options.apiBase).href;
  }

  function planIdle() {
    if (!canPlay()) { stop(); return; }
    if (!currentImage && !pendingImage && timer === null) {
      schedule(Math.max(0, idleDelay - (Date.now() - idleSince)), nextPhoto);
    }
  }

  function noteActivity() {
    idleSince = Date.now();
    if (!currentImage) {
      stop();
      planIdle();
    }
  }

  function update(nextContext) {
    if (!options) return;
    var wasPlaying = context.awake && context.canPlay;
    context = nextContext;
    if (!wasPlaying && context.awake && context.canPlay) idleSince = Date.now();
    planIdle();
    refresh();
  }

  window.EddyFrame = {
    mount: function (configuration) {
      if (options) return;
      options = configuration;
      elements = {
        slide: document.getElementById('frameSlide'),
        toggle: document.getElementById('frameToggle'),
        switchVisual: document.getElementById('frameSwitchVisual'),
        retry: document.getElementById('frameRetry'),
        status: document.getElementById('frameStatus'),
        address: document.getElementById('frameManageAddress')
      };
      elements.toggle.addEventListener('click', toggle);
      elements.retry.addEventListener('click', function () { invalidate(); });
      elements.slide.addEventListener('click', function (event) {
        event.stopPropagation();
        dismiss();
        options.onDismiss();
      });
    },
    update: update,
    invalidate: invalidate,
    noteActivity: noteActivity,
    dismiss: dismiss,
    shutdown: function () {
      update({ awake: false, canPlay: false });
    }
  };
}());

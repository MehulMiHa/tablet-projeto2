(function () {
  'use strict';

  var idleDelay = 30000;
  var slideDelay = 10000;
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
  var transition = null;
  var cursor = 0;
  var clockLayout = null;

  function placeClock(image) {
    if (!elements.clock || !image) return;
    var w = elements.slide.clientWidth;
    var h = elements.slide.clientHeight;
    if (!w || !h) return;
    var boxW = Math.min(w * .92, 680);
    var boxH = Math.min(h * .4, 335);
    var x = (w - boxW) / 2;
    var positions = [Math.max(28, h * .055), h - boxH - Math.max(28, h * .055)];
    var canvas = document.createElement('canvas');
    canvas.width = 80; canvas.height = Math.max(1, Math.round(h / w * 80));
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var best = { y: positions[0], score: Infinity };
    try {
      if (ctx) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        var scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        var iw = image.naturalWidth * scale, ih = image.naturalHeight * scale;
        ctx.drawImage(image, (canvas.width - iw) / 2, (canvas.height - ih) / 2, iw, ih);
        var pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        positions.forEach(function (y) {
          var score = 0, count = 0, prev = 0;
          var sx = Math.floor(x / w * canvas.width), ex = Math.ceil((x + boxW) / w * canvas.width);
          var sy = Math.floor(y / h * canvas.height), ey = Math.min(canvas.height, Math.ceil((y + boxH) / h * canvas.height));
          for (var py = sy; py < ey; py++) for (var px = sx; px < ex; px++) {
            var index = (py * canvas.width + px) * 4;
            var r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
            var light = .2126 * r + .7152 * g + .0722 * b;
            // Prefer quiet, dark space; warm skin tones are a conservative subject-avoidance hint.
            var skin = r > 75 && r > g * 1.12 && g > b * 1.04 && r - b > 22 ? 100 : 0;
            score += light * .7 + Math.abs(light - prev) * 1.2 + skin; prev = light; count++;
          }
          score = score / Math.max(1, count) + (clockLayout && Math.abs(y - clockLayout.y) > 10 ? 5 : 0);
          if (score < best.score) best = { y: y, score: score };
        });
      }
    } catch (ignored) { /* Cross-origin photos retain the readable gradient fallback. */ }
    canvas.width = canvas.height = 1;
    var previous = elements.clock.getBoundingClientRect();
    elements.ambient.classList.add('with-frame');
    elements.clock.style.setProperty('--frame-clock-top', best.y + 'px');
    elements.clock.style.setProperty('--frame-clock-width', boxW + 'px');
    elements.ambient.dataset.frameClock = best.y < h / 2 ? 'top' : 'bottom';
    clockLayout = best;
    if (typeof elements.clock.animate === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      var next = elements.clock.getBoundingClientRect();
      var difference = previous.top - next.top;
      if (Math.abs(difference) > 8) elements.clock.animate([
        { translate: '0 ' + difference + 'px', opacity: 1, filter: 'blur(0px)' },
        { translate: '0 ' + difference * .48 + 'px', opacity: .88, filter: 'blur(1px)', offset: .48 },
        { translate: '0 0', opacity: 1, filter: 'blur(0px)' }
      ], { duration: 1900, easing: 'cubic-bezier(.22,.7,.2,1)' });
    }
  }

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
    if (outgoingImage && !photos.some(function (photo) { return photo.id === outgoingImage.dataset.photoId; })) clearTransition();
    if (pendingImage && !photos.some(function (photo) { return photo.id === pendingImage.dataset.photoId; })) stop();
    if (currentImage && photos.length > 1 && timer === null && !transition) schedule(slideDelay, nextPhoto);
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

  function clearTransition() {
    if (transition) transition.cancel();
    transition = null;
    release(outgoingImage);
    outgoingImage = null;
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
    clearTimeout(imageTimeout);
    clearTransition();
    release(pendingImage);
    release(currentImage);
    pendingImage = null;
    currentImage = null;
    elements.slide.hidden = true;
    elements.ambient.classList.remove('with-frame');
    delete elements.ambient.dataset.frameClock;
    if (elements.clock && elements.clock.getAnimations) elements.clock.getAnimations().forEach(function (animation) { animation.cancel(); });
    clockLayout = null;
  }

  function dismiss() {
    if (!currentImage) return false;
    stop();
    noteActivity();
    return true;
  }

  function display(image) {
    clearTransition();
    var previous = currentImage;
    currentImage = image;
    image.hidden = false;
    elements.slide.hidden = false;
    placeClock(image);
    if (previous && window.EddyFrameTransitions) {
      outgoingImage = previous;
      transition = window.EddyFrameTransitions.play(elements.slide, previous, image, function () {
        clearTransition();
        if (canPlay() && album.photos.length > 1) schedule(slideDelay, nextPhoto);
      });
      if (transition) return true;
      clearTransition();
    } else release(previous);
    return false;
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
      if (success) {
        if (display(image)) return;
      }
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
        ambient: document.getElementById('ambient'),
        clock: document.querySelector('.ambient-center'),
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
      window.addEventListener('resize', function () { if (currentImage) placeClock(currentImage); });
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

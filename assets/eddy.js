(function () {
  'use strict';

  var API_BASE = window.EDDY_API_BASE || 'http://127.0.0.1:3000';
  var LIGHT_IDS = ['sanca', 'foco-1', 'foco-2', 'foco-3', 'foco-4', 'foco-5', 'foco-6', 'foco-7', 'foco-8'];
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SUCTION_LABELS = { 101: 'Silencioso', 102: 'Normal', 103: 'Turbo', 104: 'Máximo' };
  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  var robotAlerts = [];
  var lastRobotUpdate = 0;
  var serverOnline = false;
  var stateAttempted = false;
  var selectedLights = new Set(LIGHT_IDS);
  var selectionBackup = new Set(LIGHT_IDS);
  var selecting = false;
  var lightPreview = null;
  var lightBusy = false;
  var robotBusy = false;
  var syncBusy = false;
  var pollBusy = false;
  var pollTimer = null;
  var eventStream = null;
  var inactivityTimer = null;
  var sleepTimer = null;
  var pointerDown = false;
  var lightDrag = null;
  var suppressFixtureClickUntil = 0;
  var sheetOpen = false;
  var sheetCloseTimer = null;
  var toastTimer = null;
  var screen = 'clock';
  var panelTransitionTimer = null;
  var rememberedAt = 0;
  var rememberedValue = '';
  var charging = true;
  var powerLostAt = null;
  var linkLostAt = null;
  var emergencyActive = false;
  var emergencyTimer = null;
  var emergencyDismissed = false;
  var cameraStream = null;
  var cameraCheck = null;
  var cameraGeneration = 0;
  var draft = { vacuumRooms: [], mopRooms: [], suction: 102, water: 15, tab: 'rooms', roomMode: 'vacuum', zoneMode: 'vacuum' };
  var map = { metadata: null, image: null, loading: false, loadedAt: 0, error: '', rectangle: null, gesture: null, transform: null };

  function nativeCall(name, value) {
    try {
      if (window.AndroidSync && typeof window.AndroidSync[name] === 'function') {
        if (arguments.length > 1) return window.AndroidSync[name](value);
        return window.AndroidSync[name]();
      }
    } catch (error) {
      console.warn('Integração Android indisponível', name);
    }
    return null;
  }

  function icon(name) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function asTime(value) {
    if (typeof value === 'number') return value;
    var parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function connection(name) {
    return state && state.connections && state.connections[name] ? state.connections[name] : { online: false };
  }

  function robotOnline() {
    return !!(serverOnline && state && state.robot && (connection('robot').online || state.robot.online));
  }

  function lightItems() {
    return state && state.lights && Array.isArray(state.lights.items) ? state.lights.items : [];
  }

  function lightName(id) {
    return id === 'sanca' ? 'Fita LED' : 'Foco ' + id.split('-')[1];
  }

  function selectedTitle() {
    if (selectedLights.size === 9) return 'Sala';
    if (selectedLights.size === 8 && !selectedLights.has('sanca')) return 'Focos';
    if (selectedLights.size === 1) return lightName(Array.from(selectedLights)[0]);
    if (selectedLights.size === 0) return 'Escolher luzes';
    return selectedLights.size + ' luzes selecionadas';
  }

  function showToast(message, error) {
    var toast = $('toast');
    clearTimeout(toastTimer);
    toast.querySelector('span').textContent = message;
    toast.querySelector('use').setAttribute('href', error ? '#i-alert' : '#i-check');
    toast.classList.toggle('is-error', !!error);
    toast.hidden = false;
    requestAnimationFrame(function () { toast.classList.add('is-visible'); });
    toastTimer = setTimeout(function () {
      toast.classList.remove('is-visible');
      setTimeout(function () { if (!toast.classList.contains('is-visible')) toast.hidden = true; }, 220);
    }, error ? 6500 : 3200);
  }

  async function api(path, options) {
    options = options || {};
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, options.timeout || 10000);
    try {
      var request = { method: options.method || 'GET', signal: controller.signal, cache: 'no-store' };
      if (options.body !== undefined) {
        request.headers = { 'Content-Type': 'application/json' };
        request.body = JSON.stringify(options.body);
      }
      var response = await fetch(API_BASE + path, request);
      var data = null;
      try { data = await response.json(); } catch (error) { /* An empty response has no data. */ }
      if (!response.ok) {
        var reason = data && (data.message || data.error);
        if (reason && typeof reason === 'object') reason = reason.message;
        throw new Error(typeof reason === 'string' ? reason : 'O pedido não foi confirmado. Tenta novamente.');
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('A resposta está a demorar. Confirma a ligação antes de repetir.');
      if (error instanceof TypeError) throw new Error('Sem ligação ao painel. A tentar restabelecer.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function requestId() {
    var random = new Uint32Array(2);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(random);
    else { random[0] = Math.floor(Math.random() * 4294967296); random[1] = Date.now() >>> 0; }
    return Date.now().toString(36) + '-' + random[0].toString(36) + '-' + random[1].toString(36);
  }

  function restoreSnapshot() {
    var stored = nativeCall('getSnapshot');
    if (!stored) {
      try { stored = localStorage.getItem('eddy.snapshot.v2'); } catch (error) { stored = null; }
    }
    if (stored) {
      try {
        var parsed = JSON.parse(stored);
        state = parsed.state || parsed;
        if (!state || typeof state !== 'object') state = null;
        if (state) {
          robotAlerts = state.robot && Array.isArray(state.robot.alerts) ? state.robot.alerts : (Array.isArray(state.alerts) ? state.alerts : []);
          lastRobotUpdate = state.robot ? asTime(state.robot.updatedAt) : 0;
        }
      } catch (error) { state = null; }
    }
    try {
      var savedDraft = JSON.parse(localStorage.getItem('eddy.cleaning.v2') || 'null');
      if (savedDraft) {
        draft.vacuumRooms = Array.isArray(savedDraft.vacuumRooms) ? savedDraft.vacuumRooms.filter(Number.isFinite) : [];
        draft.mopRooms = Array.isArray(savedDraft.mopRooms) ? savedDraft.mopRooms.filter(Number.isFinite) : [];
        draft.suction = [101, 102, 103, 104].indexOf(savedDraft.suction) >= 0 ? savedDraft.suction : 102;
        draft.water = number(savedDraft.water) !== null ? Math.max(1, Math.min(30, savedDraft.water)) : 15;
        draft.roomMode = ['vacuum', 'mop', 'vacuum_mop'].indexOf(savedDraft.roomMode) >= 0 ? savedDraft.roomMode : 'vacuum';
        draft.zoneMode = ['vacuum', 'mop', 'vacuum_mop'].indexOf(savedDraft.zoneMode) >= 0 ? savedDraft.zoneMode : 'vacuum';
      }
    } catch (error) { /* Storage is optional. */ }
  }

  function rememberSnapshot(force) {
    if (!state) return;
    var snapshot = {
      now: state.now,
      connections: state.connections,
      lights: state.lights,
      sync: state.sync,
      robot: state.robot ? Object.assign({}, state.robot, { alerts: robotAlerts }) : { alerts: robotAlerts },
      rooms: state.rooms,
      alerts: robotAlerts,
      weather: state.weather
    };
    var serialized = JSON.stringify(snapshot);
    if (serialized === rememberedValue || (!force && Date.now() - rememberedAt < 15000)) return;
    rememberedAt = Date.now();
    rememberedValue = serialized;
    try { localStorage.setItem('eddy.snapshot.v2', serialized); } catch (error) { /* Native storage still works. */ }
    nativeCall('rememberSnapshot', serialized);
  }

  function mergeState(incoming) {
    if (!incoming || typeof incoming !== 'object' || !incoming.connections) throw new Error('Resposta incompleta do painel.');
    var previousAlerts = JSON.stringify(robotAlerts);
    var incomingRobot = incoming.robot || {};
    var freshAt = asTime(incomingRobot.updatedAt);
    var freshRobot = !!(incomingRobot.online || (incoming.connections.robot && incoming.connections.robot.online));
    if (freshRobot && freshAt >= lastRobotUpdate && freshAt > 0 && Array.isArray(incomingRobot.alerts)) {
      robotAlerts = incomingRobot.alerts;
      lastRobotUpdate = freshAt;
    }
    state = incoming;
    if (!state.robot) state.robot = {};
    state.robot.alerts = robotAlerts;
    serverOnline = true;
    rememberSnapshot(previousAlerts !== JSON.stringify(robotAlerts));
  }

  async function refreshState() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      var mode = document.body.dataset.sleep === 'true' ? 'sleep' : screen === 'clock' ? 'idle' : 'active';
      mergeState(await api('/api/state?mode=' + mode));
    } catch (error) {
      serverOnline = false;
    } finally {
      pollBusy = false;
      stateAttempted = true;
      render();
      checkEmergency();
    }
  }

  async function poll() {
    clearTimeout(pollTimer);
    await refreshState();
    var delay = document.body.dataset.sleep === 'true' ? 10000 : screen === 'clock' ? 5000 : 1700;
    pollTimer = setTimeout(poll, delay);
  }

  function attachEvents() {
    if (!window.EventSource || eventStream) return;
    eventStream = new EventSource(API_BASE + '/api/events');
    var receive = function (event) {
      try { handleDeviceEvent(JSON.parse(event.data), event.type); } catch (error) { /* A malformed event is ignored. */ }
    };
    eventStream.onmessage = receive;
    ['button', 'motion', 'state'].forEach(function (type) { eventStream.addEventListener(type, receive); });
  }

  function handleDeviceEvent(event, eventType) {
    var type = event.type || eventType;
    if (type === 'motion') {
      if (event.motion === true) wake(false);
      return;
    }
    if (type === 'button') {
      wake(!sheetOpen);
      if (sheetOpen) return;
      var group = event.group || event.target;
      if (Array.isArray(event.ids) && event.ids.length) {
        var ids = event.ids.filter(function (id) { return LIGHT_IDS.indexOf(id) >= 0; });
        if (!ids.length) return;
        cancelSelection();
        selectedLights = new Set(ids);
        renderLights();
      } else if (group === 'led' || group === 'sanca') chooseGroup('led');
      else if (group === 'spots' || group === 'focos') chooseGroup('spots');
      else if (group === 'all' || group === 'sala') chooseGroup('all');
      return;
    }
    if (type === 'state') refreshState();
  }

  function updateClock() {
    var date = new Date();
    var time = date.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit', hour12: false });
    $('ambientTime').textContent = time;
    $('headerTime').textContent = time;
    var dateLabel = date.toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });
    $('ambientDate').textContent = dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);
    renderFreshness();
  }

  function resetSleepTimer() {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(goToSleep, 10 * 60 * 1000);
  }

  function markInteraction() {
    resetSleepTimer();
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(function checkIdle() {
      if (pointerDown || sheetOpen) { inactivityTimer = setTimeout(checkIdle, 10000); return; }
      if (screen !== 'clock') showClock();
    }, 10000);
  }

  function wake(openControls) {
    var wasSleeping = document.body.dataset.sleep === 'true';
    delete document.body.dataset.sleep;
    if (wasSleeping) nativeCall('setDimmed', false);
    resetSleepTimer();
    if (openControls) setView('lights');
    else if (wasSleeping) {
      showClock();
      refreshState();
    }
  }

  function showClock(animate) {
    var snapshot = null;
    if (screen !== 'clock' && animate !== false) {
      try { snapshot = window.EddyPanelTransition.captureView(screen); } catch (error) { /* The clock remains available during recovery. */ }
    }
    window.EddyPanelTransition.cancel();
    if (screen === 'lights') transitionPanel('room-out', snapshot ? 1300 : 520);
    closeCleaning();
    cancelSelection();
    $('lightScope').open = false;
    selectedLights = new Set(LIGHT_IDS);
    screen = 'clock';
    document.body.dataset.screen = 'clock';
    $('dashboard').setAttribute('aria-hidden', 'true');
    $('ambient').setAttribute('aria-hidden', 'false');
    renderLights();
    renderAmbient();
    if (snapshot) {
      try { window.EddyPanelTransition.play(snapshot, 'clock'); }
      catch (error) { window.EddyPanelTransition.cancel(); }
    }
  }

  function goToSleep() {
    if (emergencyActive && !$('emergencyLight').hidden) { resetSleepTimer(); return; }
    showClock(false);
    document.body.dataset.sleep = 'true';
    nativeCall('setDimmed', true);
  }

  function openFromClock() {
    var robot = state && state.robot;
    var showRobot = robotOnline() && (isCleaning(robot) || isPaused(robot));
    var wasSleeping = document.body.dataset.sleep === 'true';
    wake(false);
    setView(showRobot ? 'robot' : 'lights', !wasSleeping);
  }

  function setView(view, withClockAnimation) {
    var previous = screen;
    var clockTransition = null;
    if (previous === 'clock' && withClockAnimation !== false) {
      try { clockTransition = window.EddyPanelTransition.capture(); } catch (error) { /* Navigation still works without the animation. */ }
    } else if (previous !== view && previous !== 'clock') {
      try { clockTransition = window.EddyPanelTransition.captureView(previous); } catch (error) { /* Keep navigation responsive. */ }
    }
    window.EddyPanelTransition.cancel();
    if (view === 'lights' && previous !== 'lights') {
      transitionPanel(previous === 'clock' && clockTransition ? 'room-in' : 'room-tab', previous === 'clock' && clockTransition ? 1300 : 1000);
    }
    screen = view;
    document.body.dataset.screen = view;
    delete document.body.dataset.sleep;
    nativeCall('setDimmed', false);
    $('dashboard').setAttribute('aria-hidden', 'false');
    $('ambient').setAttribute('aria-hidden', 'true');
    $('lightsView').hidden = view !== 'lights';
    $('robotView').hidden = view !== 'robot';
    renderAmbient();
    if (clockTransition) {
      try { window.EddyPanelTransition.play(clockTransition, view); }
      catch (error) { window.EddyPanelTransition.cancel(); }
    }
    document.querySelectorAll('[data-view]').forEach(function (button) {
      var active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (view === 'robot') { cancelSelection(); loadMap(false); }
    markInteraction();
    refreshState();
  }

  function transitionPanel(direction, duration) {
    clearTimeout(panelTransitionTimer);
    document.body.dataset.panelTransition = direction;
    panelTransitionTimer = setTimeout(function () {
      delete document.body.dataset.panelTransition;
    }, duration);
  }

  function shiftOLED() {
    var minute = Math.floor(Date.now() / 60000);
    var style = document.documentElement.style;
    style.setProperty('--oled-x', (Math.sin(minute / 60 * 2 * Math.PI) * 3).toFixed(2) + 'vw');
    style.setProperty('--oled-y-factor', Math.sin(minute / 720 * 2 * Math.PI).toFixed(4));
    style.setProperty('--alert-oled-x', (((minute % 7) - 3) * 3) + 'px');
    style.setProperty('--alert-oled-y', (((Math.floor(minute / 7) % 7) - 3) * 3) + 'px');
  }

  function buildFixtures() {
    var container = $('spotFixtures');
    for (var index = 1; index <= 8; index++) {
      var column = index > 4 ? 1 : 0;
      var row = 3 - ((index - 1) % 4);
      var group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('class', 'fixture is-unknown');
      group.setAttribute('data-light-id', 'foco-' + index);
      group.setAttribute('role', 'button');
      group.setAttribute('tabindex', '0');
      group.setAttribute('aria-label', 'Foco ' + index + ', a obter estado');
      group.setAttribute('transform', 'translate(' + (200 + column * 200) + ' ' + (170 + row * 180) + ')');
      [
        ['circle', { 'class': 'spot-well', r: 59 }],
        ['circle', { 'class': 'spot-glow emitted-glow', r: 40, filter: 'url(#softGlow)' }],
        ['circle', { 'class': 'spot-light emitted-light', r: 40 }],
        ['circle', { 'class': 'spot-center', r: 29 }],
        ['circle', { 'class': 'selection-outline', r: 63 }],
        ['circle', { 'class': 'spot-hit', r: 77 }]
      ].forEach(function (definition) {
        var shape = document.createElementNS(SVG_NS, definition[0]);
        Object.keys(definition[1]).forEach(function (key) { shape.setAttribute(key, definition[1][key]); });
        group.appendChild(shape);
      });
      var label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'spot-number');
      label.setAttribute('y', '6');
      label.textContent = index;
      group.appendChild(label);
      container.appendChild(group);
    }
    document.querySelectorAll('[data-light-id]').forEach(function (fixture) {
      fixture.addEventListener('click', function () { selectFixture(fixture.dataset.lightId); });
      fixture.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectFixture(fixture.dataset.lightId); }
      });
    });
  }

  function selectFixture(id) {
    if (lightBusy || Date.now() < suppressFixtureClickUntil) return;
    if (selecting) {
      if (selectedLights.has(id)) selectedLights.delete(id);
      else selectedLights.add(id);
    } else selectedLights = new Set([id]);
    markInteraction();
    renderLights();
  }

  function chooseGroup(group) {
    selecting = false;
    document.body.classList.remove('is-selecting');
    selectedLights = new Set(group === 'led' ? ['sanca'] : group === 'spots' ? LIGHT_IDS.slice(1) : LIGHT_IDS);
    renderLights();
  }

  function beginSelection() {
    if (lightBusy) return;
    selectionBackup = new Set(selectedLights);
    selectedLights.clear();
    selecting = true;
    document.body.classList.add('is-selecting');
    renderLights();
  }

  function cancelSelection() {
    if (!selecting) return;
    lightDrag = null;
    $('lightDragBox').hidden = true;
    selectedLights = new Set(selectionBackup);
    selecting = false;
    document.body.classList.remove('is-selecting');
    renderLights();
  }

  function finishSelection() {
    if (selectedLights.size === 0) return;
    selecting = false;
    document.body.classList.remove('is-selecting');
    renderLights();
  }

  function beginLightDrag(event) {
    if (!selecting || lightBusy || !event.isPrimary || event.button !== 0) return;
    if (event.target.closest('button')) return;
    lightDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, box: null };
  }

  function moveLightDrag(event) {
    if (!lightDrag || event.pointerId !== lightDrag.id) return;
    var dx = event.clientX - lightDrag.x;
    var dy = event.clientY - lightDrag.y;
    if (!lightDrag.box && Math.max(Math.abs(dx), Math.abs(dy)) < 14) return;
    var plan = $('roomPlan').getBoundingClientRect();
    var left = Math.max(plan.left, Math.min(lightDrag.x, event.clientX));
    var top = Math.max(plan.top, Math.min(lightDrag.y, event.clientY));
    var right = Math.min(plan.right, Math.max(lightDrag.x, event.clientX));
    var bottom = Math.min(plan.bottom, Math.max(lightDrag.y, event.clientY));
    lightDrag.box = { left: left, top: top, right: right, bottom: bottom };
    var box = $('lightDragBox');
    box.hidden = false;
    box.style.left = (left - plan.left) + 'px';
    box.style.top = (top - plan.top) + 'px';
    box.style.width = (right - left) + 'px';
    box.style.height = (bottom - top) + 'px';
    event.preventDefault();
  }

  function endLightDrag(event, cancelled) {
    if (!lightDrag || event.pointerId !== lightDrag.id) return;
    var box = lightDrag.box;
    lightDrag = null;
    $('lightDragBox').hidden = true;
    if (!box || cancelled) return;
    suppressFixtureClickUntil = Date.now() + 200;
    var hits = Array.from(document.querySelectorAll('#spotFixtures .fixture')).filter(function (fixture) {
      var target = fixture.querySelector('.spot-hit').getBoundingClientRect();
      return box.left <= target.right && box.right >= target.left && box.top <= target.bottom && box.bottom >= target.top;
    }).map(function (fixture) { return fixture.dataset.lightId; });
    var alreadySelected = hits.every(function (id) { return selectedLights.has(id); });
    hits.forEach(function (id) {
      if (alreadySelected) selectedLights.delete(id);
      else selectedLights.add(id);
    });
    renderLights();
  }

  function temperatureRGB(kelvin) {
    var temp = Math.max(2000, Math.min(6500, kelvin)) / 100;
    var red = temp <= 66 ? 255 : 329.698727446 * Math.pow(temp - 60, -.1332047592);
    var green = temp <= 66 ? 99.4708025861 * Math.log(temp) - 161.1195681661 : 288.1221695283 * Math.pow(temp - 60, -.0755148492);
    var blue = temp >= 66 ? 255 : temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
    return [red, green, blue].map(function (channel) { return Math.round(Math.max(0, Math.min(255, channel))); });
  }

  function renderLights() {
    var items = lightItems();
    var byId = {};
    items.forEach(function (item) { byId[item.id] = item; });
    document.querySelectorAll('[data-light-id]').forEach(function (fixture) {
      var id = fixture.dataset.lightId;
      var item = byId[id];
      var displayed = item;
      if (item && lightPreview && selectedLights.has(id)) displayed = Object.assign({}, item, lightPreview);
      var known = !!(displayed && typeof displayed.on === 'boolean');
      var rgb = displayed && Array.isArray(displayed.rgb) ? displayed.rgb : [190, 200, 190];
      if (displayed && lightPreview && selectedLights.has(id) && lightPreview.temperature) rgb = temperatureRGB(lightPreview.temperature);
      var brightness = displayed && number(displayed.brightness) !== null ? displayed.brightness : 0;
      fixture.style.setProperty('--light-rgb', rgb.map(function (n) { return Math.max(0, Math.min(255, Number(n) || 0)); }).join(', '));
      fixture.style.setProperty('--light-opacity', known && displayed.on ? (.32 + .68 * brightness / 100).toFixed(3) : '.065');
      fixture.classList.toggle('is-on', known && displayed.on);
      fixture.classList.toggle('is-unknown', !known);
      fixture.classList.toggle('is-unreachable', !!(item && item.reachable === false));
      fixture.classList.toggle('is-selected', selectedLights.has(id) && (selecting || selectedLights.size !== 9));
      fixture.setAttribute('aria-pressed', String(selectedLights.has(id)));
      var label = !known ? 'estado indisponível' : displayed.on ? 'ligado, ' + Math.round(brightness) + ' por cento' : 'desligado';
      if (known && (!serverOnline || !connection('hue').online || item.reachable === false)) label += ', última leitura';
      fixture.setAttribute('aria-label', lightName(id) + ', ' + label);
    });

    $('selectionHint').hidden = !selecting;
    $('selectionActions').hidden = !selecting;
    $('finishSelection').disabled = selectedLights.size === 0;
    $('selectedLightTitle').textContent = selectedTitle();
    var selected = items.filter(function (item) { return selectedLights.has(item.id); });
    var powered = selected.filter(function (item) { return item.on; });
    var available = serverOnline && connection('hue').online && selected.length > 0 && !selecting && !lightBusy;
    var allKnown = selected.length === selectedLights.size;
    var status = 'A obter estado';
    if (selectedLights.size === 0) status = 'Toca na planta para escolher';
    else if (!serverOnline || !connection('hue').online) status = items.length ? 'Último estado · sem ligação' : 'Sem ligação às luzes';
    else if (allKnown && powered.length === 0) status = selected.length === 1 ? 'Desligada' : 'Todas desligadas';
    else if (allKnown && powered.length === selected.length) status = selected.length === 1 ? 'Ligada' : 'Todas ligadas';
    else if (allKnown) status = powered.length + ' de ' + selected.length + ' ligadas';
    if (allKnown && selected.some(function (item) { return item.reachable === false; })) {
      status += ' · ligação parcial';
    }
    if (lightPreview) status = 'Pré-visualização';
    $('selectedLightStatus').textContent = status;
    $('lightPower').disabled = !available;
    $('lightPower').classList.toggle('is-on', powered.length > 0);
    $('lightPower').setAttribute('aria-label', (powered.length ? 'Apagar ' : 'Ligar ') + selectedTitle().toLowerCase());
    $('brightness').disabled = !available;
    $('temperature').disabled = !available;
    if (!lightPreview) {
      var reference = powered.length ? powered : selected;
      var values = reference.map(function (item) { return item.brightness; }).filter(function (value) { return number(value) !== null; });
      var temperatures = reference.map(function (item) { return item.temperature; }).filter(function (value) { return number(value) !== null; });
      var sameBrightness = values.length && values.every(function (value) { return Math.abs(value - values[0]) < 2; });
      var sameTemperature = temperatures.length && temperatures.every(function (value) { return Math.abs(value - temperatures[0]) < 100; });
      if (values.length) $('brightness').value = Math.round(values.reduce(function (sum, value) { return sum + value; }, 0) / values.length);
      if (temperatures.length) $('temperature').value = Math.round(temperatures.reduce(function (sum, value) { return sum + value; }, 0) / temperatures.length);
      $('brightnessValue').textContent = values.length ? sameBrightness ? Math.round(values[0]) + '%' : 'Misto' : '—';
      $('temperatureValue').textContent = temperatures.length ? sameTemperature ? Math.round(temperatures[0] / 50) * 50 + ' K' : 'Misto' : '—';
    }
    rangeFill($('brightness'));
    document.querySelectorAll('[data-light-group]').forEach(function (button) {
      var group = button.dataset.lightGroup;
      var active = group === 'all' ? selectedLights.size === 9 : group === 'led' ? selectedLights.size === 1 && selectedLights.has('sanca') : selectedLights.size === 8 && !selectedLights.has('sanca');
      button.classList.toggle('is-active', active && !selecting);
      button.disabled = lightBusy;
    });
    var syncOnline = serverOnline && connection('sync').online;
    var syncActive = !!(state && state.sync && state.sync.active);
    $('syncToggle').disabled = !syncOnline || syncBusy;
    $('syncToggle').setAttribute('aria-pressed', String(syncActive));
    $('syncSwitch').classList.toggle('is-on', syncActive);
    $('syncStatus').textContent = syncOnline ? syncActive ? 'As luzes acompanham a imagem' : 'Desativada' : 'Sem ligação à Sync Box';
  }

  function rangeFill(input) {
    var min = Number(input.min);
    var max = Number(input.max);
    input.style.setProperty('--range-fill', ((Number(input.value) - min) / (max - min) * 100) + '%');
  }

  function previewLight(property, value) {
    lightPreview = { on: true };
    lightPreview[property] = Number(value);
    $(property + 'Value').textContent = property === 'brightness' ? Math.round(value) + '%' : Math.round(value) + ' K';
    $('lightFeedback').textContent = 'A ajustar';
    $('lightFeedback').classList.remove('is-error');
    renderLights();
  }

  async function sendLightControl(change) {
    if (lightBusy || selecting || !selectedLights.size) return;
    lightBusy = true;
    $('lightFeedback').textContent = 'A confirmar nas luzes…';
    $('lightFeedback').classList.remove('is-error');
    renderLights();
    try {
      var result = await api('/api/lights/control', { method: 'POST', body: Object.assign({ ids: Array.from(selectedLights) }, change), timeout: 45000 });
      lightPreview = null;
      if (result && result.lights && state) state.lights = result.lights;
      await refreshState();
      $('lightFeedback').textContent = 'Confirmado';
      if (result && Array.isArray(result.warnings) && result.warnings.length) showToast(result.warnings.join(' '), true);
    } catch (error) {
      lightPreview = null;
      $('lightFeedback').textContent = error.message;
      $('lightFeedback').classList.add('is-error');
      showToast(error.message, true);
    } finally {
      lightBusy = false;
      renderLights();
      markInteraction();
    }
  }

  async function toggleSync() {
    if (syncBusy || !state || !state.sync) return;
    syncBusy = true;
    $('syncToggle').classList.add('is-busy');
    renderLights();
    try {
      var result = await api('/api/sync', { method: 'POST', body: { active: !state.sync.active }, timeout: 45000 });
      var confirmed = result && result.sync;
      if (confirmed) state.sync = confirmed;
      await refreshState();
      showToast(confirmed ? confirmed.active ? 'Sincronização TV ativada' : 'Sincronização TV desativada' : 'Pedido de sincronização recebido');
    } catch (error) { showToast(error.message, true); }
    finally { syncBusy = false; $('syncToggle').classList.remove('is-busy'); renderLights(); markInteraction(); }
  }

  function isPaused(robot) {
    return robot && (robot.phase === 'paused' || robot.state === 'paused' || robot.stateCode === 10);
  }

  function isCleaning(robot) {
    return robot && ['vacuuming', 'mopping', 'vacuum_mop', 'cleaning', 'returning', 'mapping'].indexOf(robot.phase) >= 0;
  }

  function renderRobot() {
    var robot = state && state.robot ? state.robot : {};
    var online = robotOnline();
    var label = robot.label || 'A obter estado';
    var job = robot.currentJob;
    var hasMotion = isCleaning(robot) || isPaused(robot);
    var atBase = ['charging', 'charged', 'charging_complete', 'docked', 'charging_error'].indexOf(robot.state) >= 0 || ['washing_mops', 'drying_mops', 'attaching_mops', 'detaching_mops', 'emptying_dust'].indexOf(robot.phase) >= 0;
    $('robotState').textContent = online ? label : robot.label ? 'Último estado · ' + label.toLowerCase() : 'Sem ligação ao Rocky';
    var detail = '';
    if (!online) detail = 'A tentar restabelecer a ligação';
    else if (hasMotion) detail = robot.location && robot.location.kind !== 'unknown' ? robot.location.label : 'Localização por confirmar';
    else if (robot.phase === 'idle' && !robotAlerts.length) detail = 'Pronto para a próxima limpeza';
    if (job && job.message && ['accepted', 'preparing', 'starting', 'running', 'waiting', 'paused', 'interrupted'].indexOf(job.status) >= 0) detail = job.message;
    if (job && job.resumeAt && isPaused(robot)) {
      detail = 'Retoma prevista às ' + new Date(job.resumeAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
    }
    if (job && job.error) detail = job.error;
    $('robotStateDetail').textContent = detail;
    $('robotStateDetail').hidden = !detail;
    $('robotConnection').textContent = online ? 'Ligado' : 'Sem ligação';
    $('robotConnection').hidden = online;
    $('robotConnection').classList.toggle('is-offline', !online);
    $('robotVisual').classList.toggle('is-active', online && screen === 'robot' && (isCleaning(robot) || ['washing_mops', 'drying_mops', 'emptying_dust'].indexOf(robot.phase) >= 0));
    $('robotVisual').classList.toggle('has-alert', robotAlerts.length > 0);
    $('openCleaning').disabled = !online || robotBusy;
    $('openZoneCleaning').disabled = !online || robotBusy;
    $('robotPause').disabled = !online || robotBusy || (!isCleaning(robot) && !isPaused(robot));
    $('robotHome').disabled = !online || robotBusy || atBase;
    $('robotPause15').disabled = !online || robotBusy || !isCleaning(robot);
    var inProgress = online && !atBase && (hasMotion || robot.inReturning > 0 || robot.phase === 'returning');
    $('robotDestinations').hidden = inProgress;
    $('robotView').classList.toggle('has-current-cleaning', inProgress);
    $('robotPause').hidden = !online || !hasMotion;
    $('robotHome').hidden = !online || atBase || robot.phase === 'returning' || robot.inReturning > 0;
    $('robotPause15').hidden = !online || !isCleaning(robot);
    $('robotPause').querySelector('span').textContent = isPaused(robot) ? 'Retomar' : 'Pausar';
    $('robotPause').querySelector('use').setAttribute('href', isPaused(robot) ? '#i-play' : '#i-pause');
    var alerts = $('robotAlerts');
    var signature = JSON.stringify(robotAlerts) + online;
    if (alerts.dataset.signature !== signature) {
      alerts.dataset.signature = signature;
      renderRobotAlerts(alerts, online);
    }
    renderFreshness();
  }

  function renderRobotAlerts(alerts, online) {
    clear(alerts);
    robotAlerts.forEach(function (alert) {
      var card = document.createElement('div');
      card.className = 'device-alert' + (alert.severity === 'error' ? ' is-error' : '');
      card.appendChild(icon(alert.id === 'clean-water-empty' ? 'drop' : 'alert'));
      var copy = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = alert.title || 'Aviso do Rocky';
      copy.appendChild(title);
      var description = document.createElement('p');
      description.textContent = alert.detail || (alert.id === 'clean-water-empty' ? 'Enche o depósito da base e volta a colocá-lo.' : 'Consulta o estado do aspirador.');
      if (!online) description.textContent += ' Última informação confirmada. A atualizar a ligação.';
      copy.appendChild(description);
      card.appendChild(copy);
      alerts.appendChild(card);
    });
  }

  function renderFreshness() {
    var stamp = state && state.robot ? asTime(state.robot.updatedAt) : 0;
    $('robotConnection').title = stamp ? 'Última leitura às ' + new Date(stamp).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) : '';
  }

  function renderAmbient() {
    var warning = robotAlerts.filter(function (alert) { return alert.id === 'clean-water-empty'; })[0] || robotAlerts[0];
    $('ambientAlert').hidden = !warning;
    $('ambient').classList.toggle('has-alert', !!warning);
    if (warning) {
      $('ambientAlertTitle').textContent = warning.title || 'Aviso do Rocky';
      $('ambientAlertStatus').textContent = robotOnline() ? 'Rocky · base' : 'Último aviso confirmado · a restabelecer ligação';
      $('ambientAlert').querySelector('use').setAttribute('href', warning.id === 'clean-water-empty' ? '#i-drop' : '#i-alert');
    }
    if (window.EddyAmbientRocky) {
      window.EddyAmbientRocky.render({
        robot: state && state.robot ? Object.assign({}, state.robot, { alerts: robotAlerts }) : null,
        online: robotOnline(), busy: robotBusy, visible: screen === 'clock',
        getMap: async function () {
          var metadata = await api('/api/robot/map', { timeout: 45000 });
          if (metadata && metadata.imageUrl) metadata.imageUrl = new URL(metadata.imageUrl, API_BASE).href;
          return metadata;
        },
        onControl: function (action, button) {
          wake(false);
          markInteraction();
          return robotControl(action, button);
        }
      });
    }
    var weatherElement = $('ambientWeather');
    var weather = state && state.weather ? state.weather : {};
    var signature = JSON.stringify([weather.outdoorTemperature, weather.indoorTemperature, weather.rainProbability]);
    if (weatherElement.dataset.signature === signature) return;
    weatherElement.dataset.signature = signature;
    clear(weatherElement);
    [
      { label: 'Fora', value: weather.outdoorTemperature, suffix: '°' },
      { label: 'Dentro', value: weather.indoorTemperature, suffix: '°' },
      { label: 'Chuva', value: weather.rainProbability, suffix: '%' }
    ].forEach(function (reading) {
      if (number(reading.value) === null) return;
      var span = document.createElement('span');
      var label = document.createElement('small');
      label.textContent = reading.label;
      span.appendChild(label);
      span.appendChild(document.createTextNode(Math.round(reading.value) + reading.suffix));
      weatherElement.appendChild(span);
    });
  }

  function renderConnection() {
    var hue = serverOnline && connection('hue').online;
    var robot = robotOnline();
    var connected = hue && robot;
    var element = $('connectionStatus');
    element.classList.toggle('is-online', connected);
    element.classList.toggle('is-offline', !connected);
    element.querySelector('span:last-child').textContent = connected ? 'Ligado' : hue || robot ? 'Ligação parcial' : state ? 'Sem ligação' : 'A ligar';
    element.title = !serverOnline ? 'A restabelecer ligação ao painel' : [!hue ? 'Luzes sem ligação' : '', !robot ? 'Rocky sem ligação' : ''].filter(Boolean).join(' · ');
  }

  function render() {
    renderConnection();
    renderLights();
    renderRobot();
    renderAmbient();
    if (sheetOpen) { renderRooms(); updateCleaning(); }
  }

  function saveDraft() {
    try { localStorage.setItem('eddy.cleaning.v2', JSON.stringify(draft)); } catch (error) { /* No command is stored or replayed. */ }
  }

  function openCleaning(tab) {
    setView('robot');
    clearTimeout(sheetCloseTimer);
    sheetOpen = true;
    $('sheetBackdrop').hidden = false;
    $('cleaningSheet').hidden = false;
    $('cleaningSettings').open = false;
    $('roomModePicker').open = false;
    $('cleaningError').hidden = true;
    $('suction').value = draft.suction;
    $('water').value = draft.water;
    setCleaningTab(tab || 'rooms');
    renderRooms();
    updateCleaning();
    requestAnimationFrame(function () {
      $('sheetBackdrop').classList.add('is-open');
      $('cleaningSheet').classList.add('is-open');
      $('closeCleaning').focus();
    });
  }

  function closeCleaning() {
    if (!sheetOpen) return;
    sheetOpen = false;
    saveDraft();
    $('sheetBackdrop').classList.remove('is-open');
    $('cleaningSheet').classList.remove('is-open');
    $('roomModePicker').open = false;
    sheetCloseTimer = setTimeout(function () {
      if (!sheetOpen) { $('sheetBackdrop').hidden = true; $('cleaningSheet').hidden = true; }
    }, 260);
    var opener = draft.tab === 'zone' ? $('openZoneCleaning') : $('openCleaning');
    if (!opener.disabled && !opener.closest('[hidden]')) opener.focus();
    markInteraction();
  }

  function setCleaningTab(tab) {
    draft.tab = tab;
    $('roomModePicker').open = false;
    $('selectAllRooms').hidden = tab !== 'rooms';
    $('roomsPanel').hidden = tab !== 'rooms';
    $('zonePanel').hidden = tab !== 'zone';
    $('roomsTab').classList.toggle('is-active', tab === 'rooms');
    $('zoneTab').classList.toggle('is-active', tab === 'zone');
    $('roomsTab').setAttribute('aria-selected', String(tab === 'rooms'));
    $('zoneTab').setAttribute('aria-selected', String(tab === 'zone'));
    if (tab === 'zone') {
      loadMap(true);
      requestAnimationFrame(drawMap);
    }
    renderRooms();
    updateCleaning();
  }

  function roomModeKeys() {
    return draft.roomMode === 'vacuum_mop' ? ['vacuumRooms', 'mopRooms'] : [draft.roomMode === 'mop' ? 'mopRooms' : 'vacuumRooms'];
  }

  function roomHasMode(id) {
    return roomModeKeys().every(function (key) { return draft[key].indexOf(id) >= 0; });
  }

  function toggleRoom(id) {
    var remove = roomHasMode(id);
    roomModeKeys().forEach(function (key) {
      var index = draft[key].indexOf(id);
      if (remove && index >= 0) draft[key].splice(index, 1);
      else if (!remove && index < 0) draft[key].push(id);
    });
    saveDraft();
    renderRooms();
    updateCleaning();
  }

  function selectAllRooms() {
    var rooms = state && Array.isArray(state.rooms) ? state.rooms : [];
    var allSelected = rooms.length && rooms.every(function (room) { return roomHasMode(room.id); });
    roomModeKeys().forEach(function (key) { draft[key] = allSelected ? [] : rooms.map(function (room) { return room.id; }); });
    saveDraft();
    renderRooms();
    updateCleaning();
  }

  function renderRooms() {
    var list = $('roomList');
    var rooms = state && Array.isArray(state.rooms) ? state.rooms : [];
    var validIds = rooms.map(function (room) { return room.id; });
    if (rooms.length) {
      draft.vacuumRooms = draft.vacuumRooms.filter(function (id) { return validIds.indexOf(id) >= 0; });
      draft.mopRooms = draft.mopRooms.filter(function (id) { return validIds.indexOf(id) >= 0; });
    }
    var signature = JSON.stringify(rooms) + JSON.stringify(draft.vacuumRooms) + JSON.stringify(draft.mopRooms) + draft.roomMode + robotOnline();
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    clear(list);
    if (!rooms.length) {
      var empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = robotOnline() ? 'A obter as divisões do mapa…' : 'Liga o Rocky para obter as divisões.';
      list.appendChild(empty);
      return;
    }
    rooms.forEach(function (room) {
      var row = document.createElement('button');
      var vacuum = draft.vacuumRooms.indexOf(room.id) >= 0;
      var mop = draft.mopRooms.indexOf(room.id) >= 0;
      var selected = roomHasMode(room.id);
      var partial = draft.roomMode === 'vacuum_mop' && vacuum !== mop;
      var name = room.name || 'Divisão ' + room.id;
      row.type = 'button';
      row.className = 'rocky-room-tile' + (selected ? ' is-selected' : '') + (partial ? ' is-partial' : '');
      row.dataset.roomId = room.id;
      row.setAttribute('aria-pressed', partial ? 'mixed' : String(selected));
      row.setAttribute('aria-label', name + (vacuum || mop ? ', ' + (vacuum && mop ? 'aspirar e lavar' : vacuum ? 'aspirar' : 'lavar') : ', sem limpeza selecionada'));
      var tick = document.createElement('span');
      tick.className = 'rocky-room-check';
      tick.appendChild(icon(selected ? 'check' : partial ? 'vacuum' : 'map'));
      row.appendChild(tick);
      var copy = document.createElement('span');
      copy.className = 'rocky-room-copy';
      var label = document.createElement('span');
      label.className = 'room-name';
      label.textContent = name;
      copy.appendChild(label);
      var modes = document.createElement('span');
      modes.className = 'rocky-room-modes';
      modes.textContent = vacuum && mop ? 'Aspirar e lavar' : vacuum ? 'Aspirar' : mop ? 'Lavar' : 'Por selecionar';
      copy.appendChild(modes);
      row.appendChild(copy);
      row.addEventListener('click', function () {
        toggleRoom(room.id);
        var replacement = list.querySelector('[data-room-id="' + room.id + '"]');
        if (replacement) replacement.focus({ preventScroll: true });
      });
      list.appendChild(row);
    });
  }

  function updateCleaning() {
    var zone = draft.tab === 'zone';
    var vacuum = zone ? draft.zoneMode !== 'mop' : draft.vacuumRooms.length > 0;
    var mop = zone ? draft.zoneMode !== 'vacuum' : draft.mopRooms.length > 0;
    var mode = zone ? draft.zoneMode : draft.roomMode;
    $('roomModeName').textContent = mode === 'vacuum_mop' ? 'Aspirar e lavar' : mode === 'mop' ? 'Lavar' : 'Aspirar';
    $('roomModeIcon').setAttribute('href', mode === 'mop' ? '#i-drop' : '#i-vacuum');
    document.querySelectorAll('[data-clean-mode]').forEach(function (button) {
      var active = button.dataset.cleanMode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    var rooms = state && Array.isArray(state.rooms) ? state.rooms : [];
    var allSelected = rooms.length && rooms.every(function (room) { return roomHasMode(room.id); });
    $('selectAllRooms').textContent = allSelected ? 'Desmarcar todas' : 'Todas';
    $('selectAllRooms').disabled = !rooms.length;
    $('selectAllRooms').setAttribute('aria-label', (allSelected ? 'Desmarcar' : 'Marcar') + ' todas para ' + $('roomModeName').textContent.toLowerCase());
    $('cleaningSettings').hidden = !vacuum && !mop;
    $('suctionSetting').hidden = !vacuum;
    $('waterSetting').hidden = !mop;
    $('suctionValue').textContent = SUCTION_LABELS[draft.suction] || 'Normal';
    $('waterValue').textContent = draft.water + ' / 30';
    $('cleaningSettingSummary').textContent = [vacuum ? SUCTION_LABELS[draft.suction] : '', mop ? 'Água ' + draft.water : ''].filter(Boolean).join(' · ');
    rangeFill($('suction'));
    rangeFill($('water'));
    var valid = robotOnline() && !robotBusy;
    var summary;
    if (zone) {
      valid = valid && !!(map.rectangle && map.transform && map.image && !map.error && !map.loading);
      summary = map.error || (map.loading ? 'A atualizar o mapa…' : map.transform ? 'Apenas a área selecionada será limpa.' : 'A obter a posição correta da área.');
    } else {
      valid = valid && (vacuum || mop);
      var parts = [];
      if (vacuum) parts.push(draft.vacuumRooms.length + ' para aspirar');
      if (mop) parts.push(draft.mopRooms.length + ' para lavar');
      summary = parts.length ? parts.join(' · ') : 'Escolhe pelo menos uma divisão.';
    }
    if (!robotOnline()) summary = 'Aguardamos uma ligação atualizada ao Rocky.';
    $('cleaningSummary').textContent = summary;
    $('startCleaning').disabled = !valid;
  }

  async function startCleaning() {
    if (robotBusy || $('startCleaning').disabled) return;
    var body = { requestId: requestId(), vacuumRooms: draft.vacuumRooms.slice(), mopRooms: draft.mopRooms.slice(), suction: draft.suction, water: draft.water };
    if (draft.tab === 'zone') {
      var zone = calibratedZone();
      if (!zone) { $('cleaningError').textContent = 'O mapa ainda não permite confirmar esta área.'; $('cleaningError').hidden = false; return; }
      body.vacuumRooms = [];
      body.mopRooms = [];
      body.zones = [zone];
      body.zoneMode = draft.zoneMode;
    }
    robotBusy = true;
    $('startCleaning').classList.add('is-busy');
    $('cleaningError').hidden = true;
    updateCleaning();
    try {
      await api('/api/robot/clean', { method: 'POST', body: body, timeout: 45000 });
      closeCleaning();
      showToast('Ordem recebida. A aguardar confirmação do Rocky.');
      await refreshState();
    } catch (error) {
      $('cleaningError').textContent = error.message;
      $('cleaningError').hidden = false;
    } finally {
      robotBusy = false;
      $('startCleaning').classList.remove('is-busy');
      renderRobot();
      updateCleaning();
      markInteraction();
    }
  }

  async function robotControl(action, button) {
    if (robotBusy || !robotOnline()) return;
    robotBusy = true;
    button.classList.add('is-busy');
    renderRobot();
    renderAmbient();
    try {
      await api('/api/robot/control', { method: 'POST', body: { requestId: requestId(), action: action }, timeout: 45000 });
      showToast('Pedido enviado. A atualizar o estado do Rocky.');
      await refreshState();
    } catch (error) { showToast(error.message, true); }
    finally { robotBusy = false; button.classList.remove('is-busy'); renderRobot(); renderAmbient(); markInteraction(); }
  }

  function calibrationTransform(calibration) {
    var points = Array.isArray(calibration) ? calibration : calibration && Array.isArray(calibration.points) ? calibration.points : [];
    if (points.length < 3) return null;
    var pairs = points.map(function (point) {
      var pixel = point.map || point.pixel || point.image;
      var vacuum = point.vacuum || point.robot;
      if (!pixel || !vacuum || [pixel.x, pixel.y, vacuum.x, vacuum.y].some(function (n) { return number(n) === null; })) return null;
      return { x: pixel.x, y: pixel.y, u: vacuum.x, v: vacuum.y };
    }).filter(Boolean);
    if (pairs.length < 3) return null;
    var p = pairs.slice(0, 3);
    var determinant = p[0].x * (p[1].y - p[2].y) + p[1].x * (p[2].y - p[0].y) + p[2].x * (p[0].y - p[1].y);
    if (Math.abs(determinant) < .0001) return null;
    function coefficients(key) {
      return {
        a: (p[0][key] * (p[1].y - p[2].y) + p[1][key] * (p[2].y - p[0].y) + p[2][key] * (p[0].y - p[1].y)) / determinant,
        b: (p[0][key] * (p[2].x - p[1].x) + p[1][key] * (p[0].x - p[2].x) + p[2][key] * (p[1].x - p[0].x)) / determinant,
        c: (p[0][key] * (p[1].x * p[2].y - p[2].x * p[1].y) + p[1][key] * (p[2].x * p[0].y - p[0].x * p[2].y) + p[2][key] * (p[0].x * p[1].y - p[1].x * p[0].y)) / determinant
      };
    }
    var transform = { x: coefficients('u'), y: coefficients('v') };
    var primary = Math.abs(transform.x.a * transform.y.b);
    var alternate = Math.abs(transform.x.b * transform.y.a);
    if (Math.max(primary, alternate) < .0001) return null;
    var xAngle = Math.min(Math.abs(transform.x.a), Math.abs(transform.x.b)) / Math.max(Math.abs(transform.x.a), Math.abs(transform.x.b));
    var yAngle = Math.min(Math.abs(transform.y.a), Math.abs(transform.y.b)) / Math.max(Math.abs(transform.y.a), Math.abs(transform.y.b));
    if (xAngle > .001 || yAngle > .001) return null;
    return transform;
  }

  function calibratedZone() {
    if (!map.transform || !map.rectangle) return null;
    var rect = map.rectangle;
    var points = [{ x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y }, { x: rect.x + rect.w, y: rect.y + rect.h }, { x: rect.x, y: rect.y + rect.h }].map(function (point) {
      return { x: map.transform.x.a * point.x + map.transform.x.b * point.y + map.transform.x.c, y: map.transform.y.a * point.x + map.transform.y.b * point.y + map.transform.y.c };
    });
    return [Math.round(Math.min.apply(null, points.map(function (point) { return point.x; }))), Math.round(Math.min.apply(null, points.map(function (point) { return point.y; }))), Math.round(Math.max.apply(null, points.map(function (point) { return point.x; }))), Math.round(Math.max.apply(null, points.map(function (point) { return point.y; }))), 1];
  }

  async function loadMap(force) {
    if (map.loading || (!force && Date.now() - map.loadedAt < 60000)) return;
    if (map.gesture) return;
    map.loading = true;
    map.error = '';
    $('zoneMessage').textContent = 'A obter o mapa real…';
    $('zoneMessage').hidden = !!map.image;
    updateCleaning();
    try {
      var metadata = await api('/api/robot/map', { timeout: 45000 });
      if (!metadata || !metadata.imageUrl) throw new Error('O Rocky ainda não disponibilizou o mapa. Tenta novamente dentro de instantes.');
      var imageURL = new URL(metadata.imageUrl, API_BASE + '/');
      if (imageURL.origin !== new URL(API_BASE).origin) throw new Error('O mapa recebido tem uma origem inesperada.');
      var image = new Image();
      await new Promise(function (resolve, reject) {
        var timeout = setTimeout(function () { reject(new Error('O mapa demorou a chegar. Volta a abrir esta vista para tentar novamente.')); }, 15000);
        image.onload = function () { clearTimeout(timeout); resolve(); };
        image.onerror = function () { clearTimeout(timeout); reject(new Error('Não foi possível carregar a imagem do mapa.')); };
        image.src = imageURL.href;
      });
      var oldWidth = map.image ? map.image.naturalWidth : 0;
      var oldHeight = map.image ? map.image.naturalHeight : 0;
      var changedCalibration = map.metadata && JSON.stringify(map.metadata.calibration) !== JSON.stringify(metadata.calibration);
      map.metadata = metadata;
      map.image = image;
      var dimensionsMatch = metadata.width === image.naturalWidth && metadata.height === image.naturalHeight;
      map.transform = dimensionsMatch ? calibrationTransform(metadata.calibration) : null;
      map.loadedAt = Date.now();
      if (!map.rectangle || changedCalibration || oldWidth !== image.naturalWidth || oldHeight !== image.naturalHeight) {
        map.rectangle = { x: image.naturalWidth * .35, y: image.naturalHeight * .35, w: image.naturalWidth * .3, h: image.naturalHeight * .3 };
      }
      $('zoneCanvas').width = image.naturalWidth;
      $('zoneCanvas').height = image.naturalHeight;
      $('zoneCanvas').hidden = false;
      $('zoneMessage').hidden = true;
      if (!map.transform) map.error = 'A calibração do mapa está indisponível. A escolha por divisão continua disponível.';
      drawMap();
    } catch (error) {
      map.error = error.message;
      if (!map.image) { $('zoneMessage').textContent = map.error; $('zoneMessage').hidden = false; }
      else showToast(map.error, true);
    } finally {
      map.loading = false;
      updateCleaning();
    }
  }

  function drawMap() {
    if (!map.image || !sheetOpen || draft.tab !== 'zone') return;
    var canvas = $('zoneCanvas');
    var context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(map.image, 0, 0);
    var rect = map.rectangle;
    if (!rect) return;
    var screenRect = canvas.getBoundingClientRect();
    var scale = screenRect.width > 0 ? canvas.width / screenRect.width : 3;
    context.fillStyle = 'rgba(137, 220, 175, .22)';
    context.strokeStyle = '#b9f2cf';
    context.lineWidth = 2 * scale;
    context.fillRect(rect.x, rect.y, rect.w, rect.h);
    context.strokeRect(rect.x, rect.y, rect.w, rect.h);
    [{ x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y }, { x: rect.x, y: rect.y + rect.h }, { x: rect.x + rect.w, y: rect.y + rect.h }].forEach(function (point) {
      context.beginPath();
      context.arc(point.x, point.y, 6 * scale, 0, Math.PI * 2);
      context.fillStyle = '#d4f9e2';
      context.fill();
      context.strokeStyle = '#294c36';
      context.lineWidth = 1.5 * scale;
      context.stroke();
    });
  }

  function canvasPoint(event) {
    var canvas = $('zoneCanvas');
    var rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height, scale: canvas.width / rect.width };
  }

  function startZoneGesture(event) {
    if (!map.rectangle || !map.image) return;
    event.preventDefault();
    var point = canvasPoint(event);
    var rect = map.rectangle;
    var threshold = 28 * point.scale;
    var action = null;
    [{ key: 'tl', x: rect.x, y: rect.y }, { key: 'tr', x: rect.x + rect.w, y: rect.y }, { key: 'bl', x: rect.x, y: rect.y + rect.h }, { key: 'br', x: rect.x + rect.w, y: rect.y + rect.h }].some(function (corner) {
      if (Math.abs(point.x - corner.x) <= threshold && Math.abs(point.y - corner.y) <= threshold) { action = corner.key; return true; }
      return false;
    });
    if (!action && point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h) action = 'move';
    if (!action) {
      rect.x = Math.max(0, Math.min(map.image.naturalWidth - rect.w, point.x - rect.w / 2));
      rect.y = Math.max(0, Math.min(map.image.naturalHeight - rect.h, point.y - rect.h / 2));
      action = 'move';
      drawMap();
    }
    map.gesture = { action: action, x: point.x, y: point.y, rectangle: Object.assign({}, rect) };
    $('zoneCanvas').setPointerCapture(event.pointerId);
  }

  function moveZoneGesture(event) {
    if (!map.gesture) return;
    event.preventDefault();
    var point = canvasPoint(event);
    var original = map.gesture.rectangle;
    var dx = point.x - map.gesture.x;
    var dy = point.y - map.gesture.y;
    var action = map.gesture.action;
    var width = map.image.naturalWidth;
    var height = map.image.naturalHeight;
    var minimum = Math.min(width, height) * .06;
    if (action === 'move') {
      map.rectangle.x = Math.max(0, Math.min(width - original.w, original.x + dx));
      map.rectangle.y = Math.max(0, Math.min(height - original.h, original.y + dy));
    } else {
      var left = original.x;
      var top = original.y;
      var right = original.x + original.w;
      var bottom = original.y + original.h;
      if (action.indexOf('l') >= 0) left = Math.max(0, Math.min(right - minimum, original.x + dx));
      if (action.indexOf('r') >= 0) right = Math.min(width, Math.max(left + minimum, original.x + original.w + dx));
      if (action.indexOf('t') >= 0) top = Math.max(0, Math.min(bottom - minimum, original.y + dy));
      if (action.indexOf('b') >= 0) bottom = Math.min(height, Math.max(top + minimum, original.y + original.h + dy));
      map.rectangle = { x: left, y: top, w: right - left, h: bottom - top };
    }
    drawMap();
  }

  function checkEmergency() {
    var networkLost = stateAttempted && (!serverOnline || !connection('hue').online);
    if (networkLost && linkLostAt === null) linkLostAt = Date.now();
    if (!networkLost) linkLostAt = null;
    if (charging || !networkLost) {
      emergencyDismissed = false;
      stopEmergency();
      return;
    }
    if (emergencyActive || emergencyDismissed || powerLostAt === null || Math.abs(powerLostAt - linkLostAt) > 60000) return;
    emergencyActive = true;
    wake(false);
    speak('Falha de energia detetada.');
    emergencyTimer = setTimeout(checkAmbientLight, 3000);
  }

  function speak(text) {
    if (window.AndroidSync && typeof window.AndroidSync.falar === 'function') {
      nativeCall('falar', text);
      return;
    }
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
    var message = new SpeechSynthesisUtterance(text);
    message.lang = 'pt-PT';
    window.speechSynthesis.speak(message);
  }

  function setEmergencyLight(on) {
    if ($('emergencyLight').hidden === !on) return;
    $('emergencyLight').hidden = !on;
    nativeCall('setEmergencyBrightness', on);
    if (on) {
      wake(false);
      speak('A ligar a luz de emergência.');
    }
  }

  function stopEmergency() {
    if (!emergencyActive) return;
    emergencyActive = false;
    clearTimeout(emergencyTimer);
    emergencyTimer = null;
    setEmergencyLight(false);
    stopCamera();
  }

  function stopCamera() {
    cameraGeneration++;
    clearInterval(cameraCheck);
    cameraCheck = null;
    if (cameraStream) cameraStream.getTracks().forEach(function (track) { track.stop(); });
    cameraStream = null;
  }

  async function checkAmbientLight() {
    if (!emergencyActive) return;
    var generation = ++cameraGeneration;
    var firstFrameTimeout = setTimeout(function () {
      if (cameraGeneration !== generation) return;
      stopCamera();
      if (emergencyActive) setEmergencyLight(true);
    }, 6500);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Câmara indisponível');
      var stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 64 }, height: { ideal: 64 } }, audio: false });
      if (cameraGeneration !== generation || !emergencyActive) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        return;
      }
      cameraStream = stream;
      var video = document.createElement('video');
      video.muted = true;
      video.setAttribute('playsinline', '');
      video.srcObject = cameraStream;
      await video.play();
      if (cameraGeneration !== generation || !emergencyActive) return;
      var canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      var context = canvas.getContext('2d', { willReadFrequently: true });
      var highReadings = 0;
      function sample() {
        if (cameraGeneration !== generation || !emergencyActive || !video.videoWidth || !video.videoHeight) return;
        clearTimeout(firstFrameTimeout);
        try {
          context.drawImage(video, 0, 0, 16, 16);
          var pixels = context.getImageData(0, 0, 16, 16).data;
          var sum = 0;
          for (var index = 0; index < pixels.length; index += 4) sum += (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
          var luminosity = sum / 256;
          highReadings = luminosity > 70 ? highReadings + 1 : 0;
          if (luminosity < 40) setEmergencyLight(true);
          else if (highReadings >= 3) setEmergencyLight(false);
        } catch (error) {
          stopCamera();
          setEmergencyLight(true);
        }
      }
      cameraCheck = setInterval(sample, 2000);
      sample();
    } catch (error) {
      clearTimeout(firstFrameTimeout);
      if (cameraGeneration === generation && emergencyActive) {
        stopCamera();
        setEmergencyLight(true);
      }
    }
  }

  function bindEvents() {
    $('ambient').addEventListener('click', function (event) {
      if (event.target.closest('#ambientRocky')) return;
      if (event.target.closest('#ambientAlert')) { wake(false); setView('robot'); }
      else openFromClock();
    });
    $('clockButton').addEventListener('click', showClock);
    document.querySelectorAll('[data-view]').forEach(function (button) { button.addEventListener('click', function () { setView(button.dataset.view); }); });
    $('selectLights').addEventListener('click', function () { $('lightScope').open = false; beginSelection(); });
    $('cancelSelection').addEventListener('click', cancelSelection);
    $('finishSelection').addEventListener('click', finishSelection);
    $('roomPlan').addEventListener('pointerdown', beginLightDrag);
    document.addEventListener('pointermove', moveLightDrag, { passive: false });
    document.addEventListener('pointerup', function (event) { endLightDrag(event, false); });
    document.addEventListener('pointercancel', function (event) { endLightDrag(event, true); });
    document.querySelectorAll('[data-light-group]').forEach(function (button) {
      button.addEventListener('click', function () {
        $('lightScope').open = false;
        chooseGroup(button.dataset.lightGroup);
      });
    });
    document.addEventListener('click', function (event) {
      if (!event.target.closest('#lightScope')) $('lightScope').open = false;
    });
    $('lightPower').addEventListener('click', function () {
      var anyOn = lightItems().some(function (item) { return selectedLights.has(item.id) && item.on; });
      sendLightControl({ on: !anyOn });
    });
    ['brightness', 'temperature'].forEach(function (property) {
      $(property).addEventListener('input', function () { previewLight(property, $(property).value); markInteraction(); });
      $(property).addEventListener('change', function () {
        var change = {};
        change[property] = Number($(property).value);
        sendLightControl(change);
      });
    });
    $('syncToggle').addEventListener('click', toggleSync);
    $('openCleaning').addEventListener('click', function () { openCleaning('rooms'); });
    $('openZoneCleaning').addEventListener('click', function () { openCleaning('zone'); });
    $('closeCleaning').addEventListener('click', closeCleaning);
    $('sheetBackdrop').addEventListener('click', closeCleaning);
    $('roomsTab').addEventListener('click', function () { setCleaningTab('rooms'); });
    $('zoneTab').addEventListener('click', function () { setCleaningTab('zone'); });
    $('selectAllRooms').addEventListener('click', selectAllRooms);
    document.querySelectorAll('[data-clean-mode]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (draft.tab === 'zone') draft.zoneMode = button.dataset.cleanMode;
        else draft.roomMode = button.dataset.cleanMode;
        $('roomModePicker').open = false;
        saveDraft();
        renderRooms();
        updateCleaning();
      });
    });
    document.addEventListener('click', function (event) {
      if (!event.target.closest('#roomModePicker')) $('roomModePicker').open = false;
    });
    $('suction').addEventListener('input', function () { draft.suction = Number($('suction').value); saveDraft(); updateCleaning(); });
    $('water').addEventListener('input', function () { draft.water = Number($('water').value); saveDraft(); updateCleaning(); });
    $('startCleaning').addEventListener('click', startCleaning);
    $('robotPause').addEventListener('click', function () { robotControl(isPaused(state.robot) ? 'resume' : 'pause', $('robotPause')); });
    $('robotHome').addEventListener('click', function () { robotControl('home', $('robotHome')); });
    $('robotPause15').addEventListener('click', function () { robotControl('pause15', $('robotPause15')); });
    $('zoneCanvas').addEventListener('pointerdown', startZoneGesture);
    $('zoneCanvas').addEventListener('pointermove', moveZoneGesture);
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (type) { $('zoneCanvas').addEventListener(type, function () { map.gesture = null; updateCleaning(); }); });
    document.addEventListener('pointerdown', function () { pointerDown = true; markInteraction(); }, { passive: true });
    document.addEventListener('pointerup', function () { pointerDown = false; markInteraction(); }, { passive: true });
    document.addEventListener('pointercancel', function () { pointerDown = false; }, { passive: true });
    document.addEventListener('input', markInteraction, { passive: true });
    document.addEventListener('keydown', function (event) {
      markInteraction();
      if (event.key === 'Escape') { if (sheetOpen) closeCleaning(); else if (selecting) cancelSelection(); else showClock(); }
      if (event.key === 'Tab' && sheetOpen) {
        var focusable = Array.from($('cleaningSheet').querySelectorAll('button:not(:disabled), input:not(:disabled), summary')).filter(function (element) { return element.offsetParent !== null; });
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { updateClock(); refreshState(); } });
    window.addEventListener('resize', drawMap);
    $('dismissEmergency').addEventListener('click', function () { emergencyDismissed = true; stopEmergency(); });
    window.addEventListener('eddy:back', function () {
      if (!$('emergencyLight').hidden) {
        emergencyDismissed = true;
        stopEmergency();
      } else if (sheetOpen) {
        closeCleaning();
      } else if (selecting) {
        cancelSelection();
      } else {
        showClock();
      }
    });
    window.addEventListener('pagehide', function () { clearTimeout(pollTimer); if (eventStream) eventStream.close(); stopEmergency(); rememberSnapshot(true); });
  }

  window.receberEstadoBateria = function (isCharging) {
    if (charging && isCharging === false) powerLostAt = Date.now();
    else if (isCharging !== false) powerLostAt = null;
    charging = isCharging !== false;
    checkEmergency();
  };
  window.receberDadosSyncBox = function (json) {
    try {
      var data = typeof json === 'string' ? JSON.parse(json) : json;
      if (state && data && typeof data.syncActive === 'boolean') { state.sync = { active: data.syncActive }; renderLights(); }
    } catch (error) { /* Native compatibility callback. */ }
  };
  window.receberDadosDaBridge = function (encoded) {
    try {
      var events = JSON.parse(atob(encoded));
      events.forEach(function (event) {
        if (!Array.isArray(event.data)) return;
        event.data.forEach(function (item) {
          if (item.type === 'motion' && item.motion && item.motion.motion) wake(false);
          if (item.type === 'button' && item.button && item.button.last_event === 'initial_press') wake(true);
        });
      });
    } catch (error) { /* Native compatibility callback. */ }
  };

  buildFixtures();
  restoreSnapshot();
  bindEvents();
  updateClock();
  shiftOLED();
  render();
  markInteraction();
  setInterval(updateClock, 15000);
  setInterval(shiftOLED, 60000);
  attachEvents();
  poll();
}());

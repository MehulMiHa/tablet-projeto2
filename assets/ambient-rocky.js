(function () {
  'use strict';

  var current = null;
  var host = null;
  var parts = {};
  var lastConfirmed = null;
  var mapData = null;
  var mapImageKey = '';
  var mapImageValid = false;
  var mapLoading = false;
  var nextMapAt = 0;
  var controlPending = false;
  var alertSignature = '';
  var activePhases = ['vacuuming', 'mopping', 'vacuum_mop', 'returning', 'paused', 'washing_mops', 'drying_mops', 'attaching_mops', 'detaching_mops', 'emptying_dust', 'mapping', 'patrol'];
  var activeStates = ['starting', 'remote_control', 'manual', 'updating', 'going_to_target', 'special_activity', 'in_call', 'stopping_drying'];
  var phaseLabels = {
    vacuuming: 'A aspirar', mopping: 'A lavar o chão', vacuum_mop: 'A aspirar e lavar',
    returning: 'A regressar à base', paused: 'Limpeza em pausa', washing_mops: 'A lavar as mopas',
    drying_mops: 'A secar as mopas', attaching_mops: 'A colocar as mopas',
    detaching_mops: 'A retirar as mopas', emptying_dust: 'A esvaziar o depósito',
    mapping: 'A criar o mapa', patrol: 'Em ronda'
  };

  function finite(value) { return typeof value === 'number' && isFinite(value); }
  function stamp(value) {
    if (finite(value)) return value;
    var result = typeof value === 'string' ? Date.parse(value) : NaN;
    return isFinite(result) ? result : 0;
  }
  function clock(value) {
    return new Date(value).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  }
  function text(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }
  function node(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value) element.textContent = value;
    return element;
  }
  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }
  function isActive(robot) {
    return activePhases.indexOf(robot.phase) !== -1 || activeStates.indexOf(robot.state) !== -1 || robot.inCleaning > 0 || robot.inReturning > 0;
  }
  function errors(robot) {
    var list = [];
    var ids = {};
    var codes = {};
    (Array.isArray(robot.alerts) ? robot.alerts : []).forEach(function (alert) {
      if (!alert || (!alert.title && !alert.detail)) return;
      var id = alert.id || (alert.title || '') + (alert.detail || '');
      var codeKey = alert.source && alert.code !== null && alert.code !== undefined ? alert.source + ':' + alert.code : '';
      if (ids[id] || (codeKey && codes[codeKey])) return;
      ids[id] = true;
      if (codeKey) codes[codeKey] = true;
      list.push({ id: id, title: alert.title || 'Aviso do Rocky', detail: alert.detail || '', severity: alert.severity, source: alert.source, code: alert.code });
    });
    function add(id, title, detail, severity, source, code) {
      var codeKey = source && code !== null && code !== undefined ? source + ':' + code : '';
      if (!ids[id] && !(codeKey && codes[codeKey])) {
        ids[id] = true;
        if (codeKey) codes[codeKey] = true;
        list.push({ id: id, title: title, detail: detail, severity: severity, source: source, code: code });
      }
    }
    if (finite(robot.errorCode) && robot.errorCode !== 0) {
      add('robot-error-' + robot.errorCode, 'O Rocky precisa de ajuda', 'Verifica o aviso ' + robot.errorCode + ' na app Roborock.', 'error', 'robot', robot.errorCode);
    }
    if (finite(robot.dockErrorCode) && robot.dockErrorCode !== 0) {
      if (robot.dockErrorCode === 38) add('clean-water-empty', 'Encher depósito de água limpa', 'Enche e volta a colocar o depósito de água limpa na base.', 'warning', 'dock', 38);
      else add('dock-error-' + robot.dockErrorCode, 'Verificar a base do Rocky', 'A base reportou o aviso ' + robot.dockErrorCode + '.', 'warning', 'dock', robot.dockErrorCode);
    }
    if (!list.some(function (alert) { return alert.severity === 'error'; }) && (robot.phase === 'error' || robot.state === 'error' || robot.state === 'charging_error' || robot.state === 'locked')) {
      add('robot-state-error', robot.label || 'O Rocky precisa de ajuda', 'Consulta o aviso na app Roborock.', 'error');
    }
    var job = robot.currentJob;
    if (job && job.error) add('job-error', 'A limpeza precisa de atenção', String(job.error), 'error');
    else if (job && job.status === 'failed') add('job-error', 'Não foi possível concluir a limpeza', job.message || 'Consulta o estado do Rocky.', 'error');
    return list;
  }

  function makeButton(action, label, symbol) {
    var button = node('button', 'ar-control');
    button.type = 'button';
    button.dataset.action = action;
    button.appendChild(icon(symbol));
    button.appendChild(node('span', '', label));
    return button;
  }
  function setup() {
    host = document.getElementById('ambientRocky');
    if (!host) return false;
    if (host.dataset.rockyReady) return true;
    host.dataset.rockyReady = 'true';
    host.classList.add('ambient-rocky');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'Rocky, estado e controlos');
    parts.header = node('div', 'ar-header');
    var brand = node('div', 'ar-brand');
    brand.appendChild(icon('robot'));
    brand.appendChild(node('span', '', 'Rocky'));
    parts.header.appendChild(brand);
    parts.battery = node('span', 'ar-battery');
    parts.header.appendChild(parts.battery);
    host.appendChild(parts.header);
    parts.body = node('div', 'ar-body');
    var copy = node('div', 'ar-copy');
    parts.status = node('h2', 'ar-status');
    parts.location = node('p', 'ar-location');
    parts.freshness = node('p', 'ar-freshness');
    parts.metrics = node('p', 'ar-metrics');
    parts.resume = node('p', 'ar-resume');
    [parts.status, parts.location, parts.freshness, parts.metrics, parts.resume].forEach(function (element) { copy.appendChild(element); });
    parts.body.appendChild(copy);
    parts.map = node('figure', 'ar-map');
    parts.map.hidden = true;
    var imageFrame = node('div', 'ar-map-frame');
    parts.image = node('img', 'ar-map-image');
    parts.image.alt = 'Mapa real da casa com a posição confirmada do Rocky';
    parts.marker = node('span', 'ar-map-marker');
    parts.marker.setAttribute('aria-hidden', 'true');
    imageFrame.appendChild(parts.image);
    imageFrame.appendChild(parts.marker);
    parts.map.appendChild(imageFrame);
    parts.mapCaption = node('figcaption', 'ar-map-caption');
    parts.map.appendChild(parts.mapCaption);
    parts.body.appendChild(parts.map);
    host.appendChild(parts.body);
    parts.alerts = node('div', 'ar-alerts');
    parts.alerts.setAttribute('aria-live', 'polite');
    parts.alerts.setAttribute('aria-relevant', 'additions text');
    host.appendChild(parts.alerts);
    parts.controls = node('div', 'ar-controls');
    parts.pause15 = makeButton('pause15', 'Pausa 15 min', 'clock');
    parts.pause = makeButton('pause', 'Pausar', 'pause');
    parts.home = makeButton('home', 'Ir para a base', 'home');
    parts.pause15.classList.add('ar-control-primary');
    [parts.pause15, parts.pause, parts.home].forEach(function (button) { parts.controls.appendChild(button); });
    host.appendChild(parts.controls);
    parts.controlError = node('p', 'ar-control-error');
    parts.controlError.setAttribute('role', 'alert');
    parts.controlError.hidden = true;
    host.appendChild(parts.controlError);
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup'].forEach(function (eventName) {
      host.addEventListener(eventName, function (event) { event.stopPropagation(); }, false);
    });
    host.addEventListener('click', function (event) {
      event.stopPropagation();
      var button = event.target.closest('button[data-action]');
      if (!button || button.disabled || !current || typeof current.onControl !== 'function' || controlPending) return;
      var action = button.dataset.action;
      var handler = current.onControl;
      parts.controlError.hidden = true;
      controlPending = true;
      button.classList.add('is-busy');
      draw();
      Promise.resolve().then(function () { return handler(action, button); }).catch(function (error) {
        text(parts.controlError, error && error.message ? error.message : 'Não foi possível enviar o pedido ao Rocky.');
        parts.controlError.hidden = false;
      }).then(function () {
        controlPending = false;
        button.classList.remove('is-busy');
        draw();
      });
    }, false);
    return true;
  }

  // Calibration pairs describe image pixels and vacuum coordinates. Invert the
  // measured affine transform; never place the robot without these real pairs.
  function mapPoint(metadata) {
    if (!metadata || !finite(metadata.width) || !finite(metadata.height) || metadata.width <= 0 || metadata.height <= 0) return null;
    var position = metadata.robotPosition;
    if (!position || !finite(position.x) || !finite(position.y)) return null;
    var calibration = metadata.calibration;
    var raw = Array.isArray(calibration) ? calibration : calibration && calibration.points;
    if (!Array.isArray(raw)) return null;
    var pairs = raw.map(function (pair) {
      var pixel = pair && (pair.map || pair.pixel || pair.image);
      var vacuum = pair && (pair.vacuum || pair.robot);
      if (!pixel || !vacuum || !finite(pixel.x) || !finite(pixel.y) || !finite(vacuum.x) || !finite(vacuum.y)) return null;
      return { x: vacuum.x, y: vacuum.y, u: pixel.x, v: pixel.y };
    }).filter(Boolean);
    if (pairs.length < 3) return null;
    var p = pairs.slice(0, 3);
    var determinant = p[0].x * (p[1].y - p[2].y) + p[1].x * (p[2].y - p[0].y) + p[2].x * (p[0].y - p[1].y);
    if (!isFinite(determinant) || Math.abs(determinant) < .0001) return null;
    function project(key) {
      var a = (p[0][key] * (p[1].y - p[2].y) + p[1][key] * (p[2].y - p[0].y) + p[2][key] * (p[0].y - p[1].y)) / determinant;
      var b = (p[0][key] * (p[2].x - p[1].x) + p[1][key] * (p[0].x - p[2].x) + p[2][key] * (p[1].x - p[0].x)) / determinant;
      var c = (p[0][key] * (p[1].x * p[2].y - p[2].x * p[1].y) + p[1][key] * (p[2].x * p[0].y - p[0].x * p[2].y) + p[2][key] * (p[0].x * p[1].y - p[1].x * p[0].y)) / determinant;
      return a * position.x + b * position.y + c;
    }
    var x = project('u');
    var y = project('v');
    if (!finite(x) || !finite(y) || x < 0 || y < 0 || x > metadata.width || y > metadata.height) return null;
    return { x: x / metadata.width * 100, y: y / metadata.height * 100 };
  }

  function updateMap(online, stale, hasLocation) {
    var point = mapPoint(mapData);
    var available = !hasLocation && mapData && mapData.imageUrl && point;
    var mapStale = true;
    if (available) {
      var imageKey = mapData.imageUrl + '|' + (mapData.updatedAt || '');
      if (mapImageKey !== imageKey) {
        mapImageKey = imageKey;
        mapImageValid = false;
        var expectedKey = imageKey;
        var expectedWidth = mapData.width;
        var expectedHeight = mapData.height;
        parts.image.onload = function () {
          if (expectedKey !== mapImageKey) return;
          mapImageValid = parts.image.naturalWidth === expectedWidth && parts.image.naturalHeight === expectedHeight;
          draw();
        };
        parts.image.onerror = function () { if (expectedKey === mapImageKey) { mapImageValid = false; draw(); } };
        try {
          var url = new URL(mapData.imageUrl, document.baseURI);
          if (stamp(mapData.updatedAt)) url.searchParams.set('_ambient', String(stamp(mapData.updatedAt)));
          parts.image.src = url.href;
        } catch (error) { mapImageValid = false; }
      }
      parts.marker.style.left = point.x + '%';
      parts.marker.style.top = point.y + '%';
      // Keep the image's exact aspect ratio so percentages land on its pixels.
      var landscape = window.innerWidth > window.innerHeight;
      var mapWidth = window.innerWidth <= 600 ? 90 : landscape ? 115 : 135;
      var mapHeight = landscape ? 105 : 150;
      parts.map.style.width = Math.min(mapWidth, mapHeight * mapData.width / mapData.height) + 'px';
      var at = stamp(mapData.updatedAt);
      mapStale = stale || !at || Date.now() - at > 90000;
      text(parts.mapCaption, at ? (mapStale ? 'Último mapa · ' : 'Mapa · ') + clock(at) : 'Mapa · hora indisponível');
      parts.map.classList.toggle('is-stale', mapStale);
    }
    parts.map.hidden = !available || !mapImageValid;
    if (!hasLocation) {
      var mapRoom = mapData && finite(mapData.currentRoomId) && mapData.currentRoomId > 0 && typeof mapData.currentRoomName === 'string' && mapData.currentRoomName.trim();
      var roomAt = mapData && stamp(mapData.updatedAt);
      var roomStale = stale || !roomAt || Date.now() - roomAt > 90000;
      text(parts.location, mapRoom ? (roomStale ? 'Última localização · ' : '') + mapRoom : !parts.map.hidden ? (mapStale ? 'Última posição no mapa' : 'Posição confirmada no mapa') : 'Localização indisponível');
      parts.location.classList.toggle('is-unavailable', !mapRoom && parts.map.hidden);
      if (mapRoom && roomStale && roomAt) text(parts.freshness, parts.freshness.textContent + ' · localização às ' + clock(roomAt));
    }
    if (!hasLocation && online && !mapLoading && Date.now() >= nextMapAt && current && typeof current.getMap === 'function') {
      mapLoading = true;
      nextMapAt = Date.now() + 30000;
      var loader = current.getMap;
      Promise.resolve().then(function () { return loader(); }).then(function (metadata) {
        mapData = metadata && typeof metadata === 'object' ? metadata : null;
      }).catch(function () {
        // Keep a previous real map with its original timestamp, if available.
      }).then(function () { mapLoading = false; draw(); });
    }
  }

  function draw() {
    if (!current || !setup()) return;
    var supplied = current.robot && typeof current.robot === 'object' ? current.robot : {};
    var online = current.online === undefined ? supplied.online !== false : current.online === true;
    if (online && (supplied.state || supplied.phase || supplied.label || supplied.updatedAt)) {
      lastConfirmed = Object.assign({}, supplied, {
        alerts: Array.isArray(supplied.alerts) ? supplied.alerts.slice() : [],
        location: supplied.location ? Object.assign({}, supplied.location) : null,
        currentJob: supplied.currentJob ? Object.assign({}, supplied.currentJob) : null
      });
    }
    var robot = !online && lastConfirmed ? lastConfirmed : supplied;
    var warnings = errors(robot);
    // A newly received alert must remain visible even if the connection just fell.
    if (!online && robot !== supplied) {
      var seen = {};
      warnings.forEach(function (warning) {
        seen[warning.id] = true;
        if (warning.source && warning.code !== null && warning.code !== undefined) seen[warning.source + ':' + warning.code] = true;
      });
      errors(supplied).forEach(function (warning) {
        var codeKey = warning.source && warning.code !== null && warning.code !== undefined ? warning.source + ':' + warning.code : '';
        if (!seen[warning.id] && !(codeKey && seen[codeKey])) {
          warnings.push(warning);
          seen[warning.id] = true;
          if (codeKey) seen[codeKey] = true;
        }
      });
    }
    warnings.sort(function (a, b) { return (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1); });
    var hasError = warnings.some(function (warning) { return warning.severity === 'error'; });
    // Dock maintenance alone keeps the clock's original compact amber warning.
    var show = current.visible !== false && (isActive(robot) || hasError);
    host.hidden = !show;
    var ambient = document.getElementById('ambient');
    if (ambient) {
      ambient.classList.toggle('has-live-robot', show);
      ambient.classList.toggle('has-live-robot-alert', show && warnings.length > 0);
    }
    if (!show) return;
    var updatedAt = stamp(robot.updatedAt);
    var stale = !online || (updatedAt && Date.now() - updatedAt > 90000);
    host.classList.toggle('is-stale', !!stale);
    host.classList.toggle('has-warning', warnings.length > 0);
    host.classList.toggle('has-error', hasError);
    var batteryLabel = finite(robot.battery) && robot.battery >= 0 && robot.battery <= 100 ? Math.round(robot.battery) + '%' : '';
    text(parts.battery, warnings.length > 1 ? warnings.length + ' avisos' + (batteryLabel ? ' · ' + batteryLabel : '') : batteryLabel);
    text(parts.status, robot.label || phaseLabels[robot.phase] || (warnings.length ? 'O Rocky precisa de atenção' : 'Rocky em atividade'));
    text(parts.freshness, !online ? 'Sem ligação · ' + (updatedAt ? 'última leitura às ' + clock(updatedAt) : 'última informação confirmada') : stale ? 'Última leitura às ' + clock(updatedAt) + ' · a atualizar' : updatedAt ? 'Atualizado às ' + clock(updatedAt) : 'Hora da leitura indisponível');
    var location = robot.location;
    var locationAt = location && stamp(location.updatedAt);
    var hasLocation = !!(location && location.kind !== 'unknown' && typeof location.label === 'string' && location.label.trim());
    if (hasLocation) {
      var locationStale = stale || location.stale === true || (locationAt && Date.now() - locationAt > 90000);
      text(parts.location, (locationStale ? 'Última localização · ' : '') + location.label.trim());
      parts.location.classList.remove('is-unavailable');
      if (locationStale && locationAt && locationAt !== updatedAt) text(parts.freshness, parts.freshness.textContent + ' · localização às ' + clock(locationAt));
    }
    var metrics = [];
    if (finite(robot.cleanAreaM2) && robot.cleanAreaM2 > 0) metrics.push(new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 1 }).format(robot.cleanAreaM2) + ' m²');
    if (finite(robot.cleanTimeSeconds) && robot.cleanTimeSeconds > 0) metrics.push(Math.floor(robot.cleanTimeSeconds / 60) + ' min');
    text(parts.metrics, metrics.join(' · '));
    parts.metrics.hidden = !metrics.length;
    var job = robot.currentJob;
    var resumeAt = job && stamp(job.resumeAt);
    parts.resume.hidden = !(resumeAt && job.status === 'paused');
    if (!parts.resume.hidden) text(parts.resume, stale ? 'Retoma prevista às ' + clock(resumeAt) + ' · por confirmar' : 'Retoma automática às ' + clock(resumeAt));
    updateMap(online, !!stale, hasLocation);
    var signature = JSON.stringify(warnings);
    if (signature !== alertSignature) {
      alertSignature = signature;
      while (parts.alerts.firstChild) parts.alerts.removeChild(parts.alerts.firstChild);
      warnings.forEach(function (warning) {
        var alert = node('div', 'ar-alert' + (warning.severity === 'error' ? ' is-error' : ''));
        alert.appendChild(icon(warning.id === 'clean-water-empty' ? 'drop' : 'alert'));
        var copy = node('div', 'ar-alert-copy');
        copy.appendChild(node('strong', '', warning.title));
        if (warning.detail) copy.appendChild(node('p', '', warning.detail));
        alert.appendChild(copy);
        parts.alerts.appendChild(alert);
      });
      parts.alerts.scrollTop = 0;
    }
    parts.alerts.hidden = warnings.length === 0;
    parts.alerts.setAttribute('aria-label', warnings.length + (warnings.length === 1 ? ' aviso' : ' avisos'));
    var paused = robot.phase === 'paused' || robot.state === 'paused' || robot.stateCode === 10;
    var cleaning = ['vacuuming', 'mopping', 'vacuum_mop'].indexOf(robot.phase) !== -1 || ['cleaning', 'spot_cleaning', 'zone_cleaning', 'room_cleaning'].indexOf(robot.state) !== -1;
    var pausable = cleaning || paused || robot.phase === 'returning' || robot.phase === 'mapping' || robot.phase === 'patrol' || ['remote_control', 'manual', 'going_to_target'].indexOf(robot.state) !== -1;
    var atBase = ['charging', 'charged', 'charging_complete', 'docked', 'charging_error'].indexOf(robot.state) !== -1 || ['washing_mops', 'drying_mops', 'attaching_mops', 'detaching_mops', 'emptying_dust'].indexOf(robot.phase) !== -1;
    var returning = robot.phase === 'returning' || robot.inReturning > 0 || robot.state === 'docking';
    parts.pause15.hidden = !cleaning || paused;
    parts.pause.hidden = !pausable;
    parts.pause.dataset.action = paused ? 'resume' : 'pause';
    text(parts.pause.querySelector('span'), paused ? 'Retomar' : 'Pausar');
    parts.pause.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
    parts.home.hidden = atBase || returning;
    var hasControls = !parts.pause15.hidden || !parts.pause.hidden || !parts.home.hidden;
    parts.controls.hidden = !hasControls;
    [parts.pause15, parts.pause, parts.home].forEach(function (button) {
      button.disabled = !online || !!current.busy || controlPending || typeof current.onControl !== 'function';
    });
    host.classList.toggle('has-controls', hasControls);
  }

  window.EddyAmbientRocky = {
    render: function (options) { current = options || {}; draw(); }
  };
}());

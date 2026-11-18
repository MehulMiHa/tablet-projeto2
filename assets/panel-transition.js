(function () {
  'use strict';

  var duration = 1240;
  var motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  var active = null;
  var mask = document.createElement('canvas');
  var maskContext = mask.getContext('2d', { willReadFrequently: true });
  var textNodeFilter = NodeFilter.SHOW_TEXT;

  function bounds(node, start, end) {
    var range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return range.getBoundingClientRect();
  }

  function textInk(element) {
    if (!element || !maskContext) return [];
    var walker = document.createTreeWalker(element, textNodeFilter);
    var ink = [];
    var node;
    while ((node = walker.nextNode())) {
      var original = node.textContent;
      var text = original.trim();
      if (!text) continue;
      var first = original.indexOf(text);
      var box = bounds(node, first, first + text.length);
      if (box.width < 1 || box.height < 1) continue;
      var style = getComputedStyle(node.parentElement);
      var width = Math.ceil(box.width);
      var height = Math.ceil(box.height);
      mask.width = width + 4;
      mask.height = height + 4;
      maskContext.clearRect(0, 0, mask.width, mask.height);
      maskContext.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
      maskContext.textBaseline = 'middle';
      maskContext.fillText(text, 2, height / 2 + 2, width);
      var pixels = maskContext.getImageData(0, 0, mask.width, mask.height).data;
      var stride = Math.max(2, Math.floor(Math.sqrt(width * height / 1400)));
      for (var x = 2; x < width + 2; x += stride) {
        for (var y = 2; y < height + 2; y += stride) {
          if (pixels[(y * mask.width + x) * 4 + 3] > 115) {
            ink.push({ x: box.left + x - 2, y: box.top + y - 2 });
          }
        }
      }
    }
    return ink;
  }

  function captureDigits(element) {
    var node = element.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return [];
    var style = getComputedStyle(element);
    return node.textContent.split('').map(function (value, index) {
      return { glyph: value, rect: bounds(node, index, index + 1),
        fontSize: style.fontSize, fontWeight: style.fontWeight };
    });
  }

  function capture() {
    if (motionPreference.matches || document.body.dataset.sleep || !Element.prototype.animate) return null;
    var time = document.getElementById('ambientTime');
    var weather = document.getElementById('ambientWeather');
    var date = document.getElementById('ambientDate');
    var alert = document.getElementById('ambientAlert');
    var sources = [textInk(date)];
    Array.prototype.forEach.call(weather.children, function (reading) {
      sources.push(textInk(reading));
    });
    if (!alert.hidden) sources.push(textInk(document.getElementById('ambientAlertTitle')));
    var live = document.getElementById('ambientRocky');
    if (live && !live.hidden) {
      sources.push(textInk(live.querySelector('.ar-status')));
      sources.push(textInk(live.querySelector('.ar-location')));
    }
    return { from: 'clock', digits: captureDigits(time), groups: sources.filter(function (group) { return group.length; }) };
  }

  function textTargets(view) {
    var selectors;
    if (view === 'clock') {
      selectors = ['#ambientDate', '#ambientWeather > span:nth-child(1)', '#ambientWeather > span:nth-child(2)', '#ambientWeather > span:nth-child(3)', '#ambientAlertTitle', '#ambientRocky .ar-status', '#ambientRocky .ar-location'];
    } else if (view === 'lights') {
      selectors = ['#selectedLightTitle', '#lightsView label[for="brightness"]', '#lightsView label[for="temperature"]', '.sync-copy strong', '#selectedLightStatus'];
    } else {
      selectors = ['#robotTitle', '#openCleaning .rocky-choice-name strong', '#openZoneCleaning .rocky-choice-name strong', '#robotState'];
    }
    return selectors.map(function (selector) { return document.querySelector(selector); }).filter(Boolean);
  }

  function captureView(view) {
    if (motionPreference.matches || !Element.prototype.animate) return null;
    var groups = textTargets(view).map(textInk).filter(function (group) { return group.length; });
    if (view === 'lights') groups.push(outlineInk());
    return { from: view, digits: captureDigits(document.getElementById('headerTime')), groups: groups };
  }

  function planGeometry() {
    var room = document.getElementById('roomPlan');
    var plan = document.getElementById('lightPlan');
    var box = room.getBoundingClientRect();
    var css = getComputedStyle(room);
    var top = parseFloat(css.paddingTop) || 0;
    var bottom = parseFloat(css.paddingBottom) || 0;
    var scale = Math.min(plan.clientWidth / 600, plan.clientHeight / 900);
    var middleY = box.top + box.height / 2 + (top - bottom) / 2;
    return { x: box.left + box.width / 2, y: middleY, scale: scale };
  }

  function outlineInk() {
    var points = [];
    var geometry = planGeometry();
    var paths = document.querySelectorAll('#lightPlan .room-trace, #lightPlan .spot-ring');
    paths.forEach(function (shape) {
      var length = shape.getTotalLength();
      var count = shape.classList.contains('room-trace') ? 214 : 33;
      for (var index = 0; index < count; index++) {
        var point = shape.getPointAtLength(index / count * length);
        points.push({
          x: geometry.x + (point.x - 300) * geometry.scale,
          y: geometry.y + (point.y - 450) * geometry.scale
        });
      }
    });
    return points;
  }

  function sortPoints(points) {
    return points.slice().sort(function (first, second) {
      return first.x - second.x || first.y - second.y;
    });
  }

  function particlesFor(source, destination, group) {
    if (!source.length || !destination.length) return [];
    var origin = sortPoints(source);
    var target = sortPoints(destination);
    var count = Math.min(Math.max(origin.length, target.length), 180);
    var particles = [];
    for (var index = 0; index < count; index++) {
      var from = origin[Math.floor(index * origin.length / count)];
      var to = target[Math.floor(index * target.length / count)];
      var wave = Math.sin(index * 2.399 + group);
      var distance = Math.hypot(to.x - from.x, to.y - from.y);
      particles.push({
        from: from, to: to,
        bend: (20 + Math.min(distance * .17, 95)) * wave,
        delay: group * 32 + (index % 13) * 5,
        size: index % 11 === 0 ? 2 : 1.15
      });
    }
    return particles;
  }

  function cancel() {
    if (!active) return;
    var transition = active;
    active = null;
    cancelAnimationFrame(transition.frame);
    clearTimeout(transition.timer);
    transition.digits.forEach(function (animation) { animation.cancel(); });
    transition.held.forEach(function (element) { element.classList.remove('ink-arrival'); });
    transition.layer.remove();
    document.body.classList.remove('clock-in-flight', 'ink-transition');
  }

  function launchDigits(layer, digits, animations, view) {
    var target = captureDigits(document.getElementById(view === 'clock' ? 'ambientTime' : 'headerTime'));
    digits.forEach(function (digit, index) {
      if (!target[index] || !digit.rect.width) return;
      var destination = target[index].rect;
      var origin = digit.rect;
      var glyph = document.createElement('span');
      glyph.className = 'clock-transition-glyph';
      glyph.textContent = digit.glyph;
      glyph.style.left = origin.left + 'px';
      glyph.style.top = origin.top + 'px';
      glyph.style.fontSize = digit.fontSize;
      glyph.style.fontWeight = digit.fontWeight;
      glyph.style.lineHeight = origin.height + 'px';
      layer.appendChild(glyph);
      var factor = destination.height / origin.height;
      var dx = destination.left - origin.left;
      var dy = destination.top - origin.top;
      var arc = (index - (digits.length - 1) / 2) * 15;
      var animation = glyph.animate([
        { transform: 'translate(0, 0) scale(1)', offset: 0 },
        { transform: 'translate(' + (dx * .34 + arc) + 'px,' + (dy * .43 - 22 - Math.abs(arc)) + 'px) scale(' + Math.sqrt(factor) + ')', offset: .47 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + factor + ')', offset: 1 }
      ], { duration: 760 + index * 42, delay: index * 34, easing: 'cubic-bezier(.27,.68,.22,1)', fill: 'both' });
      animations.push(animation);
    });
  }

  function play(snapshot, view) {
    cancel();
    if (!snapshot || (!snapshot.groups.length && !snapshot.digits.length)) return;
    var layer = document.createElement('div');
    layer.className = 'panel-transition-layer';
    layer.setAttribute('aria-hidden', 'true');
    var canvas = document.createElement('canvas');
    var ratio = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.ceil(innerWidth * ratio);
    canvas.height = Math.ceil(innerHeight * ratio);
    layer.appendChild(canvas);
    var context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);

    var clockJourney = view === 'clock' || snapshot.from === 'clock';
    var travelDuration = clockJourney ? 930 : 650;
    var revealAt = clockJourney ? 895 : 600;
    var totalDuration = clockJourney ? duration : 940;
    document.body.classList.add('ink-transition');
    var targets = textTargets(view);
    if (!targets.length) { document.body.classList.remove('ink-transition'); return; }
    var roomInk = view === 'lights' ? outlineInk() : [];
    var streams = snapshot.groups.map(function (source, index) {
      var element = targets[index % targets.length];
      var destination = textInk(element);
      if (roomInk.length && index !== 0) {
        destination = destination.concat(roomInk.filter(function (_, point) {
          return point % Math.max(1, snapshot.groups.length - 1) === index - 1;
        }));
      }
      return particlesFor(source, destination, index);
    });
    document.body.appendChild(layer);
    var transition = { layer: layer, digits: [], held: targets, frame: null, timer: null };
    active = transition;
    targets.forEach(function (element) { element.classList.add('ink-arrival'); });
    document.body.classList.add('ink-transition');
    if (clockJourney) {
      document.body.classList.add('clock-in-flight');
      launchDigits(layer, snapshot.digits, transition.digits, view);
    } else {
      var arrivingView = document.getElementById(view === 'lights' ? 'lightsView' : 'robotView');
      var direction = view === 'robot' ? 1 : -1;
      transition.digits.push(arrivingView.animate([
        { opacity: 0, transform: 'perspective(1100px) translateX(' + (direction * 42) + 'px) rotateY(' + (direction * 5) + 'deg) scale(.97)' },
        { opacity: 1, transform: 'perspective(1100px) translateX(0) rotateY(0) scale(1)' }
      ], { duration: 700, easing: 'cubic-bezier(.2,.78,.2,1)' }));
    }

    var started = performance.now();
    var reveal = false;
    function draw(now) {
      if (active !== transition) return;
      var elapsed = now - started;
      if (!reveal && elapsed > revealAt) {
        reveal = true;
        targets.forEach(function (element) {
          element.classList.remove('ink-arrival');
          element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
        });
      }
      if (elapsed > 1140) document.body.classList.remove('clock-in-flight');
      context.clearRect(0, 0, innerWidth, innerHeight);
      streams.forEach(function (stream, group) {
        context.fillStyle = group % 3 === 2 ? '#d8cfb9' : group % 3 === 1 ? '#b4d9c9' : '#e7ede8';
        stream.forEach(function (particle) {
          var t = Math.min(1, Math.max(0, (elapsed - particle.delay) / travelDuration));
          var progress = t * t * (3 - 2 * t);
          var arc = Math.sin(Math.PI * progress) * particle.bend;
          var x = particle.from.x + (particle.to.x - particle.from.x) * progress + arc * .33;
          var y = particle.from.y + (particle.to.y - particle.from.y) * progress - arc;
          context.globalAlpha = t < .1 ? .35 + t * 4 : Math.max(0, .86 * (1 - Math.max(0, (t - .76) / .24)));
          context.fillRect(x, y, particle.size, particle.size);
        });
      });
      transition.frame = requestAnimationFrame(draw);
    }
    transition.frame = requestAnimationFrame(draw);
    transition.timer = setTimeout(cancel, totalDuration);
  }

  window.EddyPanelTransition = { capture: capture, captureView: captureView, play: play, cancel: cancel };
}());

(function () {
  'use strict';
  var settings;
  var active = null;
  var gesture = null;
  var suppressClickUntil = 0;
  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function element(view) { return document.getElementById(view === 'lights' ? 'lightsView' : 'robotView'); }
  function finish(token, committed) {
    if (!token || active !== token) return;
    active = null;
    token.animations.forEach(function (animation) { animation.cancel(); });
    [token.source, token.destination].forEach(function (view) {
      view.classList.remove('page-slide-layer');
      ['left', 'top', 'width', 'height', 'transform'].forEach(function (name) { view.style.removeProperty(name); });
    });
    token.source.hidden = committed;
    token.destination.hidden = !committed;
    if (committed) token.destination.classList.add('page-arrived');
    document.getElementById('dashboard').classList.remove('page-sliding');
  }
  function cancel() {
    gesture = null;
    if (active) finish(active, active.committed);
  }
  function offset(token, distance) {
    token.offset = distance;
    token.source.style.transform = 'translate3d(' + distance + 'px,0,0)';
    token.destination.style.transform = 'translate3d(' + (distance + token.direction * token.travel) + 'px,0,0)';
  }
  function prepare(from, to) {
    cancel();
    if (!from || from === to || from === 'clock' || to === 'clock') return null;
    var source = element(from);
    var destination = element(to);
    var dashboard = document.getElementById('dashboard');
    var box = source.getBoundingClientRect();
    var parent = dashboard.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    var token = { source: source, destination: destination, direction: to === 'robot' ? 1 : -1,
      travel: box.width + 26, offset: 0, committed: false, animations: [] };
    active = token;
    dashboard.classList.add('page-sliding');
    [source, destination].forEach(function (view) {
      view.hidden = false;
      view.classList.add('page-slide-layer');
      view.style.left = (box.left - parent.left) + 'px';
      view.style.top = (box.top - parent.top) + 'px';
      view.style.width = box.width + 'px';
      view.style.height = box.height + 'px';
    });
    offset(token, 0);
    return token;
  }
  function settle(token, committed) {
    if (!token || active !== token) return;
    token.committed = committed;
    var target = committed ? -token.direction * token.travel : 0;
    if (reduceMotion.matches || !Element.prototype.animate) { finish(token, committed); return; }
    var remaining = Math.abs(target - token.offset) / token.travel;
    var duration = Math.max(170, Math.min(470, 180 + 290 * remaining));
    [token.source, token.destination].forEach(function (view, index) {
      var initial = token.offset + (index ? token.direction * token.travel : 0);
      var final = target + (index ? token.direction * token.travel : 0);
      var animation = view.animate([
        { transform: 'translate3d(' + initial + 'px,0,0)' },
        { transform: 'translate3d(' + final + 'px,0,0)' }
      ], { duration: duration, easing: 'cubic-bezier(.2,.78,.22,1)', fill: 'forwards' });
      token.animations.push(animation);
    });
    token.animations[0].onfinish = function () { finish(token, committed); };
  }
  function play(token) {
    if (!token || active !== token) return;
    token.source.hidden = false;
    token.destination.hidden = false;
    settle(token, true);
  }
  function start(event) {
    if (!settings.canSwipe() || active || !event.isPrimary || event.button !== 0) return;
    if (event.target.closest('button, a, input, textarea, select, summary, [role="button"], canvas, .scope-options')) return;
    var view = settings.getView();
    if (view !== 'lights' && view !== 'robot') return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY,
      at: performance.now(), from: view, token: null };
  }
  function move(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    var dx = event.clientX - gesture.x;
    var dy = event.clientY - gesture.y;
    if (!gesture.token) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 14) return;
      if (!settings.canSwipe() || Math.abs(dy) > Math.abs(dx) * .8 ||
          (gesture.from === 'lights' ? dx > 0 : dx < 0)) { gesture = null; return; }
      var pending = gesture;
      var target = pending.from === 'lights' ? 'robot' : 'lights';
      var token = prepare(pending.from, target);
      gesture = pending;
      if (!token) { gesture = null; return; }
      gesture.token = token;
      document.getElementById('dashboard').setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    var token = gesture.token;
    var progress = Math.max(0, Math.min(token.travel, -token.direction * dx));
    offset(token, -token.direction * progress);
    settings.onInteraction();
  }
  function end(event, cancelled) {
    if (!gesture || event.pointerId !== gesture.id) return;
    var current = gesture;
    gesture = null;
    if (!current.token) return;
    suppressClickUntil = Date.now() + 400;
    var distance = Math.abs(current.token.offset);
    var velocity = distance / Math.max(1, performance.now() - current.at);
    var committed = !cancelled && (distance > Math.min(115, current.token.travel * .2) || (distance > 42 && velocity > .5));
    if (committed) settings.onNavigate(current.from === 'lights' ? 'robot' : 'lights', current.token);
    else settle(current.token, false);
    settings.onInteraction();
  }
  window.EddyPages = {
    prepare: prepare, play: play, cancel: cancel,
    mount: function (options) {
      if (settings) return;
      settings = options;
      var dashboard = document.getElementById('dashboard');
      dashboard.addEventListener('pointerdown', start);
      document.addEventListener('pointermove', move, { passive: false });
      document.addEventListener('pointerup', function (event) { end(event, false); });
      document.addEventListener('pointercancel', function (event) { end(event, true); });
      document.addEventListener('click', function (event) {
        if (Date.now() < suppressClickUntil && event.target.closest('#dashboard')) {
          event.preventDefault(); event.stopImmediatePropagation();
        }
      }, true);
      window.addEventListener('resize', cancel);
      document.addEventListener('visibilitychange', function () { if (document.hidden) cancel(); });
    }
  };
}());

(function () {
  'use strict';

  var motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  var twoPi = Math.PI * 2;
  var bag = [];
  var last = null;

  function clamp(value) { return Math.max(0, Math.min(1, value)); }
  function mix(a, b, p) { return a + (b - a) * p; }
  function ease(p) { return p * p * (3 - 2 * p); }
  function glide(p) { return 1 - Math.pow(1 - p, 3); }
  function segment(p, start, finish) { return ease(clamp((p - start) / (finish - start))); }
  function pulse(p) { return Math.sin(Math.PI * p); }

  function fit(image, box) {
    var scale = Math.min(box.w / image.naturalWidth, box.h / image.naturalHeight);
    var w = image.naturalWidth * scale;
    var h = image.naturalHeight * scale;
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w: w, h: h };
  }

  function place(box, dx, dy, scale) {
    return { x: box.x + dx + box.w * (1 - scale) / 2, y: box.y + dy + box.h * (1 - scale) / 2,
      w: box.w * scale, h: box.h * scale };
  }

  // The fitted start and finish rectangles for a photo have the same ratio.
  function travel(photo, from, p) {
    var to = photo.rect;
    return { x: mix(from.x, to.x, p), y: mix(from.y, to.y, p), w: mix(from.w, to.w, p), h: mix(from.h, to.h, p) };
  }

  function shot(scene, photo, box, opacity) {
    if (opacity <= 0 || box.w <= 0 || box.h <= 0) return;
    var ctx = scene.ctx;
    ctx.globalAlpha = opacity;
    ctx.drawImage(photo.image, box.x, box.y, box.w, box.h);
    ctx.globalAlpha = 1;
  }

  function inside(scene, photo, box, opacity, clipPath) {
    var ctx = scene.ctx;
    ctx.save();
    ctx.beginPath();
    clipPath(ctx);
    ctx.clip();
    shot(scene, photo, box, opacity);
    ctx.restore();
  }

  function slice(scene, photo, u, v, width, height, box, opacity) {
    if (box.w <= 0 || box.h <= 0 || width <= 0 || height <= 0 || opacity <= 0) return;
    var image = photo.image;
    var ctx = scene.ctx;
    ctx.globalAlpha = opacity;
    ctx.drawImage(image, u * image.naturalWidth, v * image.naturalHeight,
      width * image.naturalWidth, height * image.naturalHeight, box.x, box.y, box.w, box.h);
    ctx.globalAlpha = 1;
  }

  function rule(scene, x1, y1, x2, y2, opacity) {
    if (opacity <= 0) return;
    var ctx = scene.ctx;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = 'rgba(245,242,229,' + opacity + ')';
    ctx.lineWidth = Math.max(1, scene.w / 850);
    ctx.stroke();
  }

  function border(scene, box, opacity) {
    if (opacity <= 0) return;
    scene.ctx.strokeStyle = 'rgba(239,238,229,' + opacity + ')';
    scene.ctx.lineWidth = Math.max(1, scene.w / 950);
    scene.ctx.strokeRect(box.x, box.y, box.w, box.h);
  }

  function shade(scene, x, y, w, h, stops, horizontal) {
    if (w <= 0 || h <= 0) return;
    var ctx = scene.ctx;
    var ramp = ctx.createLinearGradient(x, y, x + (horizontal ? w : 0), y + (horizontal ? 0 : h));
    stops.forEach(function (stop) { ramp.addColorStop(stop[0], stop[1]); });
    ctx.fillStyle = ramp;
    ctx.fillRect(x, y, w, h);
  }

  function pivot(scene, photo, box, angle, opacity, x, y) {
    var ctx = scene.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.translate(-x, -y);
    shot(scene, photo, box, opacity);
    ctx.restore();
  }

  function iris(scene, p) {
    var a = scene.a;
    var b = scene.b;
    var q = ease(p);
    var box = travel(b, b.fromOther, segment(p, .18, .83));
    var cx = mix(a.rect.x + a.rect.w / 2, box.x + box.w / 2, q);
    var cy = box.y + box.h * mix(.44, .5, q);
    var rx = box.w * .83 * q;
    var ry = box.h * .83 * q;
    shot(scene, a, place(a.rect, 0, 0, 1 - .035 * q), 1 - segment(p, .26, .95));
    inside(scene, b, box, 1, function (ctx) { ctx.ellipse(cx, cy, rx, ry, 0, 0, twoPi); });
    scene.ctx.strokeStyle = 'rgba(239,238,229,' + (.26 * pulse(p)) + ')';
    scene.ctx.lineWidth = 1.2;
    [1, 1.065, 1.13].forEach(function (scale) {
      scene.ctx.beginPath();
      scene.ctx.ellipse(cx, cy, rx * scale, ry * scale, 0, 0, twoPi);
      scene.ctx.stroke();
    });
  }

  function galleryDoor(scene, p) {
    var turn = ease(p) * Math.PI;
    var leading = p < .5;
    var photo = leading ? scene.a : scene.b;
    var box = photo.rect;
    var widthFactor = Math.abs(Math.cos(turn));
    var hinge = mix(scene.a.rect.x, scene.b.rect.x, ease(p));
    var depth = Math.sin(turn);
    // Narrow vertical strips project the hinged card's perspective and shading.
    for (var i = 0; i < 19; i++) {
      var u = i / 19;
      var perspective = 1 + u * depth * .18;
      var w = (box.w / 19 * widthFactor) * (1 + u * depth * .06);
      var h = box.h * perspective;
      var x = hinge + box.w * widthFactor * u * (1 + u * depth * .06);
      var y = box.y - (h - box.h) / 2;
      slice(scene, photo, u, 0, 1 / 19, 1, { x: x, y: y, w: w + .65, h: h }, 1 - .25 * depth * u);
    }
    rule(scene, hinge, box.y, hinge, box.y + box.h, depth * .55);
  }

  function accordion(scene, p) {
    var w = scene.w;
    var h = scene.h;
    var b = scene.b;
    var incoming = travel(b, b.fromOther, segment(p, .25, .94));
    shot(scene, scene.a, scene.a.rect, 1 - segment(p, .20, .88));
    for (var i = 0; i < 9; i++) {
      var q = segment(p, .05 + i * .039, .66 + i * .035);
      var fold = .13 + .87 * q;
      var height = incoming.h / 9;
      var bottom = i % 2 === 0;
      var y = incoming.y + i * height + (bottom ? height * (1 - fold) : 0);
      var slide = (bottom ? -1 : 1) * w * .025 * (1 - q);
      slice(scene, b, 0, i / 9, 1, 1 / 9,
        { x: incoming.x + slide, y: y, w: incoming.w, h: height * fold + .45 }, q);
      rule(scene, incoming.x + slide, y, incoming.x + slide + incoming.w, y, pulse(q) * .25);
    }
    shade(scene, 0, h * .94, w, h * .06, [[0, 'transparent'], [1, 'rgba(0,0,0,' + (.35 * pulse(p)) + ')']], false);
  }

  function mosaic(scene, p) {
    var b = scene.b;
    var box = b.rect;
    var columns = b.rect.w > b.rect.h ? 7 : 5;
    var rows = b.rect.w > b.rect.h ? 4 : 6;
    shot(scene, scene.a, place(scene.a.rect, 0, 0, 1 - .07 * ease(p)), 1 - segment(p, .12, .83));
    for (var row = 0; row < rows; row++) {
      for (var column = 0; column < columns; column++) {
        var delay = (Math.hypot(column - columns / 2, row - rows / 2) / (columns + rows)) * .52;
        delay += ((column * 7 + row * 11) % 5) * .014;
        var q = segment(p, delay, .65 + delay);
        var scale = .30 + .70 * q;
        var cell = { x: box.x + box.w * column / columns, y: box.y + box.h * row / rows,
          w: box.w / columns + .5, h: box.h / rows + .5 };
        var tile = place(cell, (column - columns / 2) * (1 - q) * 4, (row - rows / 2) * (1 - q) * 4, scale);
        slice(scene, b, column / columns, row / rows, 1 / columns, 1 / rows, tile, q);
        border(scene, tile, .27 * pulse(q));
      }
    }
  }

  function verticalShutter(scene, p) {
    var b = scene.b;
    var box = travel(b, b.fromOther, segment(p, .17, .88));
    shot(scene, scene.a, scene.a.rect, 1 - segment(p, .18, .88));
    for (var i = 0; i < 7; i++) {
      var delay = Math.abs(i - 3) * .055;
      var q = segment(p, delay, .76 + delay);
      var w = box.w / 7;
      var x = box.x + w * i + (i < 3 ? w * (1 - q) : 0);
      var edge = i < 3 ? x : x + w * q;
      inside(scene, b, box, 1, function (ctx) { ctx.rect(x, box.y, w * q + .5, box.h); });
      rule(scene, edge, box.y, edge, box.y + box.h, .31 * pulse(q));
    }
  }

  function diagonal(scene, p) {
    var b = scene.b;
    var q = ease(p);
    var box = travel(b, b.fromOther, segment(p, .15, .85));
    var x = mix(-scene.w * .55, scene.w * 1.12, q);
    var slope = scene.w * .39;
    shot(scene, scene.a, place(scene.a.rect, -scene.w * .055 * q, 0, 1), 1 - segment(p, .28, .9));
    inside(scene, b, box, 1, function (ctx) {
      ctx.moveTo(0, 0); ctx.lineTo(x + slope, 0); ctx.lineTo(x, scene.h); ctx.lineTo(0, scene.h);
      ctx.closePath();
    });
    for (var i = 0; i < 5; i++) {
      var offset = i * scene.w * .012;
      rule(scene, x + slope + offset, 0, x + offset, scene.h, (.32 - i * .047) * pulse(p));
    }
  }

  function loom(scene, p) {
    var b = scene.b;
    var box = b.rect;
    shot(scene, scene.a, scene.a.rect, 1 - segment(p, .45, .92));
    for (var i = 0; i < 8; i++) {
      var delay = (i % 4) * .046;
      var q = segment(p, delay, .66 + delay);
      var r = segment(p, .25 + delay, .82 + delay);
      var w = box.w / 8;
      var h = box.h / 8;
      inside(scene, b, box, q, function (ctx) {
        ctx.rect(box.x + i * w, box.y + (i % 2 ? box.h * (1 - q) : 0), w + .5, box.h * q);
      });
      inside(scene, b, box, r * .67, function (ctx) {
        ctx.rect(box.x + (i % 2 ? box.w * (1 - r) : 0), box.y + i * h, box.w * r, h + .5);
      });
    }
  }

  function filmTrack(scene, p) {
    var travelDistance = scene.w * 1.02;
    var q = ease(p);
    var a = place(scene.a.rect, -travelDistance * q, 0, 1 - .075 * pulse(p));
    var b = place(scene.b.rect, travelDistance * (1 - q), 0, 1 - .075 * pulse(p));
    shot(scene, scene.a, a, 1 - .37 * q);
    shot(scene, scene.b, b, 1);
    [a, b].forEach(function (box) {
      var ctx = scene.ctx;
      border(scene, box, pulse(p) * .35);
      ctx.fillStyle = 'rgba(239,238,229,' + (.43 * pulse(p)) + ')';
      for (var i = 0; i < 12; i++) {
        var x = box.x + (i + .5) * box.w / 12;
        ctx.fillRect(x, box.y - 12, box.w / 50, 3);
        ctx.fillRect(x, box.y + box.h + 9, box.w / 50, 3);
      }
    });
  }

  function prism(scene, p) {
    var q = ease(p);
    var x = mix(-scene.w * .19, scene.w * 1.14, q);
    var band = scene.w * .13;
    var b = scene.b;
    var box = travel(b, b.fromOther, segment(p, .14, .91));
    shot(scene, scene.a, scene.a.rect, 1 - segment(p, .30, .91));
    inside(scene, b, box, 1, function (ctx) { ctx.rect(0, 0, Math.max(0, x - band), scene.h); });
    for (var i = 0; i < 5; i++) {
      var left = x - band + i * band / 5;
      var refraction = (i + 1) * scene.w * .006 * pulse(p);
      inside(scene, b, place(box, -refraction, refraction * .4, 1.006), 1 - i * .13, function (ctx) {
        ctx.rect(left, 0, band / 5 + 1, scene.h);
      });
      rule(scene, left, 0, left, scene.h, (.29 - i * .04) * pulse(p));
    }
    shade(scene, x - band, 0, band, scene.h, [[0, 'transparent'], [1, 'rgba(0,0,0,' + (.3 * pulse(p)) + ')']], true);
  }

  function curl(scene, p) {
    var a = scene.a;
    var b = scene.b;
    var x = mix(scene.w * 1.1, -scene.w * .21, ease(p));
    var arch = pulse(p) * scene.w * .24;
    var y = scene.h * .62;
    shot(scene, b, travel(b, b.fromOther, segment(p, .12, .9)), 1);
    inside(scene, a, a.rect, 1, function (ctx) {
      ctx.moveTo(0, 0); ctx.lineTo(x, 0);
      ctx.bezierCurveTo(x + arch, y * .18, x - arch * .90, y * .75, x - arch * .48, scene.h);
      ctx.lineTo(0, scene.h); ctx.closePath();
    });
    var ctx = scene.ctx;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + arch, y * .18, x - arch * .90, y * .75, x - arch * .48, scene.h);
    ctx.bezierCurveTo(x + arch * .02, y * .75, x + arch * 1.45, y * .27, x + arch * .95, 0);
    ctx.closePath();
    var sheen = ctx.createLinearGradient(x - arch - 1, 0, x + arch + 1, 0);
    sheen.addColorStop(0, 'rgba(7,9,10,0)');
    sheen.addColorStop(.42, 'rgba(5,7,8,' + (.60 * pulse(p)) + ')');
    sheen.addColorStop(.66, 'rgba(245,240,230,' + (.35 * pulse(p)) + ')');
    sheen.addColorStop(1, 'rgba(7,9,10,0)');
    ctx.fillStyle = sheen;
    ctx.fill();
  }

  function compass(scene, p) {
    var b = scene.b;
    var box = b.rect;
    var radius = Math.hypot(box.w, box.h) * .65 * ease(p);
    var cx = box.x + box.w / 2;
    var cy = box.y + box.h / 2;
    var twist = mix(Math.PI * .43, 0, ease(p));
    shot(scene, scene.a, place(scene.a.rect, 0, 0, 1 + .04 * pulse(p)), 1 - segment(p, .25, .87));
    function hex(ctx, size) {
      for (var i = 0; i < 6; i++) {
        var angle = twist + i * Math.PI / 3;
        var x = cx + Math.cos(angle) * size;
        var y = cy + Math.sin(angle) * size;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
    }
    inside(scene, b, box, 1, function (ctx) { hex(ctx, radius); });
    var ctx = scene.ctx;
    [1, 1.11].forEach(function (scale) {
      ctx.beginPath(); hex(ctx, radius * scale);
      ctx.strokeStyle = 'rgba(248,244,235,' + (.34 * pulse(p) / scale) + ')';
      ctx.lineWidth = 1.15;
      ctx.stroke();
    });
  }

  function echo(scene, p) {
    var q = ease(p);
    var b = scene.b;
    var box = travel(b, b.fromOther, segment(p, .12, .87));
    var a = place(scene.a.rect, -scene.w * .13 * q, -scene.h * .06 * q, 1 - .24 * q);
    shot(scene, scene.a, a, 1 - segment(p, .24, .84));
    for (var i = 3; i >= 1; i--) {
      var wander = (1 - q) * i;
      var trace = place(box, scene.w * .036 * wander, -scene.h * .017 * wander, 1 - wander * .075);
      shot(scene, b, trace, pulse(p) * (.21 / i));
      border(scene, trace, (.45 / i) * pulse(p));
    }
    var front = place(box, scene.w * .12 * (1 - q), scene.h * .085 * (1 - q), .78 + q * .22);
    shot(scene, b, front, segment(p, .14, .77));
    border(scene, front, .42 * pulse(p));
  }

  function orbit(scene, p) {
    var q = ease(p);
    var b = scene.b;
    var ar = place(scene.a.rect, -scene.w * .39 * q, -scene.h * .13 * Math.sin(q * Math.PI / 2), 1 - .24 * q);
    var br = place(b.rect, scene.w * .31 * (1 - q), scene.h * .15 * (1 - q), .73 + .27 * q);
    pivot(scene, scene.a, ar, -.19 * q, 1 - segment(p, .33, .85), scene.w * .24, scene.h * .67);
    pivot(scene, b, br, .20 * (1 - q), segment(p, .09, .76), scene.w * .75, scene.h * .25);
    var ctx = scene.ctx;
    ctx.beginPath();
    ctx.ellipse(scene.w * .54, scene.h * .51, scene.w * .49, scene.h * .32, -.47, 3.25 + q * .9, 4.7 + q * 1.61);
    ctx.strokeStyle = 'rgba(236,233,222,' + (.36 * pulse(p)) + ')';
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }

  function tide(scene, p) {
    var a = scene.a;
    var b = scene.b;
    var q = ease(p);
    var box = travel(b, b.fromOther, segment(p, .22, .9));
    var bands = 24;
    shot(scene, a, a.rect, 1 - segment(p, .21, .85));
    for (var i = 0; i < bands; i++) {
      var phase = q * twoPi - (i / bands) * 8;
      var lag = Math.sin(phase) * .069 * pulse(p);
      var open = segment(q, .05 + i / bands * .24 + lag, .72 + i / bands * .26 + lag);
      var drift = Math.cos(phase) * scene.w * .075 * (1 - open) * pulse(p);
      var h = box.h / bands;
      slice(scene, b, 0, i / bands, 1, 1 / bands, { x: box.x + drift, y: box.y + h * i,
        w: box.w, h: h + .48 }, open);
    }
  }

  function flipTiles(scene, p) {
    var b = scene.b;
    var box = travel(b, b.fromOther, segment(p, .12, .79));
    shot(scene, scene.a, scene.a.rect, 1 - segment(p, .12, .81));
    for (var i = 0; i < 12; i++) {
      var row = Math.floor(i / 4);
      var column = i % 4;
      var q = segment(p, .035 + .045 * (row + column), .66 + .045 * (row + column));
      var h = box.h / 3;
      var w = box.w / 4;
      var fold = Math.sin(Math.PI * q / 2);
      var x = box.x + column * w;
      var y = box.y + row * h + h * (1 - fold) * .47;
      var panel = { x: x + .5 * (1 - q), y: y - h * pulse(q) * .19,
        w: w + .5, h: h * fold + .35 };
      slice(scene, b, column / 4, row / 3, .25, 1 / 3, panel, q);
      shade(scene, panel.x, panel.y, panel.w, panel.h * .24,
        [[0, 'rgba(255,246,225,' + (.28 * pulse(q)) + ')'], [1, 'transparent']], false);
    }
  }

  function louvres(scene, p) {
    var a = scene.a;
    var b = scene.b;
    var panelCount = 8;
    for (var i = 0; i < panelCount; i++) {
      var delay = (i % 2 === 0 ? i * .025 : (panelCount - i) * .023);
      var q = segment(p, delay, .81 + delay);
      var reversed = q >= .5;
      var photo = reversed ? b : a;
      var box = photo.rect;
      var w = box.w / panelCount;
      var fold = Math.abs(Math.cos(q * Math.PI));
      var panel = { x: box.x + w * i + w * (1 - fold) / 2, y: box.y + box.h * pulse(q) * (i % 2 ? .024 : -.024),
        w: Math.max(0, w * fold - pulse(q) * 1.3 + .5), h: box.h };
      slice(scene, photo, i / panelCount, 0, 1 / panelCount, 1, panel, .52 + fold * .48);
      rule(scene, panel.x, panel.y, panel.x, panel.y + panel.h, .44 * pulse(q));
    }
  }

  function splitGate(scene, p) {
    var a = scene.a;
    var b = scene.b;
    var q = ease(p);
    var box = travel(b, b.fromOther, segment(p, .23, .94));
    var front = place(box, 0, scene.h * .043 * (1 - q), .88 + .12 * q);
    shot(scene, b, front, segment(p, .06, .68));
    var drift = scene.w * .65 * q;
    var half = a.rect.w / 2;
    var shift = scene.h * .047 * pulse(p);
    slice(scene, a, 0, 0, .5, 1, { x: a.rect.x - drift, y: a.rect.y + shift, w: half, h: a.rect.h }, 1 - .26 * q);
    slice(scene, a, .5, 0, .5, 1, { x: a.rect.x + half + drift, y: a.rect.y - shift, w: half, h: a.rect.h }, 1 - .26 * q);
    rule(scene, a.rect.x + half - drift, a.rect.y + shift, a.rect.x + half - drift, a.rect.y + shift + a.rect.h, pulse(p) * .34);
    rule(scene, a.rect.x + half + drift, a.rect.y - shift, a.rect.x + half + drift, a.rect.y - shift + a.rect.h, pulse(p) * .34);
  }

  function inkGrain(scene, p) {
    var b = scene.b;
    var box = travel(b, b.fromOther, segment(p, .13, .92));
    var w = box.w / 13;
    var h = box.h / 10;
    shot(scene, scene.a, scene.a.rect, 1 - segment(p, .35, .95));
    var ctx = scene.ctx;
    inside(scene, b, box, 1, function (path) {
      for (var row = 0; row < 10; row++) {
        for (var column = 0; column < 13; column++) {
          var order = ((row * 23 + column * 31 + row * column * 7) % 61) / 61;
          var x = box.x + column * w;
          var y = box.y + row * h;
          var q = segment(p, .08 + order * .56, .35 + order * .61);
          var length = Math.min(1, q * 1.33);
          path.rect(x + w * (1 - length) * .5, y + h * (1 - length) * .5, w * length + .6, h * length + .6);
        }
      }
    });
    ctx.fillStyle = 'rgba(242,229,211,' + (.52 * pulse(p)) + ')';
    for (var dot = 0; dot < 42; dot++) {
      var lead = (dot * 47 % 113) / 113;
      var flight = clamp((p - lead * .68) / .24);
      if (!flight || flight === 1) continue;
      var x = box.x + (((dot * 81) % 233) / 233) * box.w - 12 * flight;
      var y = box.y + (((dot * 39) % 127) / 127) * box.h - 18 * flight;
      ctx.fillRect(x, y, 1 + pulse(flight) * 2.4, 1 + pulse(flight) * 2.4);
    }
  }

  function interlock(scene, p) {
    var b = scene.b;
    var box = travel(b, b.fromOther, segment(p, .24, .89));
    var q = segment(p, .08, .82);
    var r = segment(p, .25, .94);
    var x = box.x + box.w * .52;
    var y = box.y + box.h * .48;
    shot(scene, scene.a, place(scene.a.rect, 0, -scene.h * .025 * q, 1 - .065 * q), 1 - segment(p, .25, .91));
    inside(scene, b, box, 1, function (ctx) {
      ctx.rect(box.x, box.y, box.w * q, box.h * .48);
      ctx.rect(x, box.y, box.w * .48, box.h * q);
      ctx.rect(box.x + box.w * (1 - r), y, box.w * r, box.h * .52);
      ctx.rect(box.x, box.y + box.h * (1 - r), box.w * .52, box.h * r);
    });
    var s = .38 * pulse(p);
    rule(scene, box.x, y, x, y, s);
    rule(scene, x, y, x, box.y + box.h, s);
    rule(scene, box.x, box.y, box.x + box.w * q, box.y, s);
    rule(scene, box.x + box.w * (1 - r), box.y + box.h, box.x + box.w, box.y + box.h, s);
  }

  function focalRack(scene, p) {
    var b = scene.b;
    var focus = segment(p, .1, .91);
    var box = travel(b, b.fromOther, segment(p, .15, .90));
    var cx = box.x + box.w * .53;
    var cy = box.y + box.h * .47;
    shot(scene, scene.a, place(scene.a.rect, 0, 0, 1 + .075 * ease(p)), 1 - segment(p, .12, .8));
    shot(scene, b, place(box, 0, 0, .93 + .07 * focus), segment(p, .16, .84));
    // Ring falloff evokes refocusing without relying on GPU blur support.
    var ctx = scene.ctx;
    var size = Math.min(box.w, box.h) * mix(.16, .92, focus);
    var density = .56 * pulse(p);
    var vignette = ctx.createRadialGradient(cx, cy, size * .55, cx, cy, size * 1.42);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(.55, 'rgba(0,0,0,' + (density * .32) + ')');
    vignette.addColorStop(1, 'rgba(0,0,0,' + density + ')');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, scene.w, scene.h);
    var arm = Math.min(box.w, box.h) * .047;
    var edge = Math.min(box.w, box.h) * mix(.19, .39, focus);
    [-1, 1].forEach(function (dx) {
      [-1, 1].forEach(function (dy) {
        var x = cx + dx * edge;
        var y = cy + dy * edge;
        rule(scene, x, y, x - dx * arm, y, .36 * pulse(p));
        rule(scene, x, y, x, y - dy * arm, .36 * pulse(p));
      });
    });
  }

  var effects = [
    ['iris', 1620, iris], ['gallery-door', 2180, galleryDoor], ['accordion', 2230, accordion],
    ['mosaic', 2410, mosaic], ['shutter', 1860, verticalShutter], ['diagonal', 1640, diagonal],
    ['loom', 2250, loom], ['film-track', 1560, filmTrack], ['prism', 2110, prism],
    ['curl', 1910, curl], ['compass', 1850, compass], ['echo', 2360, echo],
    ['orbit', 1920, orbit], ['tide', 2140, tide], ['flip-tiles', 2290, flipTiles],
    ['louvres', 2070, louvres], ['split-gate', 1730, splitGate], ['ink-grain', 2460, inkGrain],
    ['interlock', 1990, interlock], ['focal-rack', 2050, focalRack]
  ];

  function nextEffect() {
    if (!bag.length) {
      bag = effects.slice();
      for (var i = bag.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var entry = bag[i];
        bag[i] = bag[j];
        bag[j] = entry;
      }
      if (bag[bag.length - 1] === last) bag.unshift(bag.pop());
    }
    last = bag.pop();
    return last;
  }

  function play(surface, previous, incoming, onFinish) {
    if (motionPreference.matches || !previous.naturalWidth || !incoming.naturalWidth || !surface.clientWidth || !surface.clientHeight) return null;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    var cssW = surface.clientWidth;
    var cssH = surface.clientHeight;
    // Limit work on the S5e to 1.25 M pixels. The settled photos still use their original resolution.
    var scale = Math.min(devicePixelRatio || 1, Math.sqrt(1250000 / (cssW * cssH)));
    var w = canvas.width = Math.max(1, Math.round(cssW * scale));
    var h = canvas.height = Math.max(1, Math.round(cssH * scale));
    var viewport = { x: 0, y: 0, w: w, h: h };
    var a = { image: previous, rect: fit(previous, viewport) };
    var b = { image: incoming, rect: fit(incoming, viewport), fromOther: fit(incoming, a.rect) };
    var effect = nextEffect();
    var scene = { ctx: ctx, w: w, h: h, a: a, b: b };
    var frame;
    var begin = performance.now();
    var active = true;

    canvas.className = 'frame-transition';
    canvas.dataset.transition = effect[0];
    canvas.setAttribute('aria-hidden', 'true');
    surface.appendChild(canvas);

    function teardown() {
      if (!active) return false;
      active = false;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', finish);
      if (typeof motionPreference.removeEventListener === 'function') motionPreference.removeEventListener('change', finish);
      canvas.remove();
      canvas.width = canvas.height = 1;
      return true;
    }

    function finish() { if (teardown()) onFinish(); }
    function paint(p) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      if (p < .012) { shot(scene, a, a.rect, 1); return; }
      if (p > .986) { shot(scene, b, b.rect, 1); return; }
      effect[2](scene, p);
    }

    function tick(now) {
      if (!active) return;
      var p = (now - begin) / effect[1];
      if (p >= 1) { finish(); return; }
      try { paint(p); } catch (error) { finish(); return; }
      frame = requestAnimationFrame(tick);
    }

    paint(0);
    frame = requestAnimationFrame(tick);
    window.addEventListener('resize', finish);
    if (typeof motionPreference.addEventListener === 'function') motionPreference.addEventListener('change', finish);
    return { cancel: teardown };
  }

  window.EddyFrameTransitions = { play: play };
}());

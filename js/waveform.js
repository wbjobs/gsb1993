/*
 * waveform.js — Canvas 波形视图：缩放 / 平移 / 框选 / 播放头。
 * 纯渲染与交互组件，不直接碰音频引擎。
 */
(function (global) {
  'use strict';

  var RULER_H = 34;
  var OVERVIEW_H = 64;
  var GAP = 8;
  var LANE_GAP = 6;
  var MAX_DPR = 2;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function WaveformView(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // 数据
    this.numChannels = 0;
    this.duration = 0;
    this.pyramid = null; // { levels: [[{min,max} per channel]...], blockSize, factor, frames }

    // 视口（秒）
    this.viewStart = 0;
    this.viewEnd = 1;

    // 状态
    this.cursorTime = 0;
    this.selection = null; // {start, end}
    this.playhead = null;

    // 尺寸（CSS 像素）
    this._width = 1;
    this._height = 1;

    this._onSelectionChange = null;
    this._onCursorChange = null;
    this._onSeek = null;

    this._drag = null;

    // 离屏底层（波形/标尺/选区不变时只渲染一次，播放时每帧仅叠加播放头）
    this._baseCanvas = document.createElement('canvas');
    this._baseCtx = this._baseCanvas.getContext('2d');
    this._baseDirty = true;
    this._baseQueued = false;

    this._bindEvents();
    this.resize();
  }

  WaveformView.prototype.setData = function (info) {
    this.numChannels = info.numChannels;
    this.duration = info.duration;
    this.pyramid = info.pyramid;
    this.selection = null;
    this.cursorTime = 0;
    this.playhead = null;
    this.viewStart = 0;
    this.viewEnd = this.duration;
    this.resize();
    this._invalidate();
  };

  WaveformView.prototype.clear = function () {
    this.numChannels = 0;
    this.duration = 0;
    this.pyramid = null;
    this.selection = null;
    this.cursorTime = 0;
    this.playhead = null;
    this._invalidate();
  };

  WaveformView.prototype.setPlayhead = function (t) {
    this.playhead = t;
    this.draw();
  };

  WaveformView.prototype.setSelection = function (start, end) {
    if (start === null || end === null || end <= start) {
      this.selection = null;
    } else {
      this.selection = { start: clamp(start, 0, this.duration), end: clamp(end, 0, this.duration) };
    }
    this._invalidate();
    if (this._onSelectionChange) this._onSelectionChange(this.selection);
  };

  WaveformView.prototype.setCursor = function (t) {
    this.cursorTime = clamp(t, 0, this.duration);
    if (this._onCursorChange) this._onCursorChange(this.cursorTime);
    this.draw();
  };

  /* ---------------- 几何 / 坐标 ---------------- */

  WaveformView.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    // ResizeObserver 在同一容器上观察时，避免尺寸未变引起的自触发抖动
    if (w === this._width && h === this._height &&
        this._dpr === Math.min(window.devicePixelRatio || 1, MAX_DPR)) {
      return;
    }
    var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this._dpr = dpr;
    this._width = w;
    this._height = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._baseCanvas.width = this.canvas.width;
    this._baseCanvas.height = this.canvas.height;
    this._baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._rebuildBase();
    this.draw();
  };

  /** 标记底层需要重建（视口/选区/数据变化时调用），rAF 内合并多次请求。 */
  WaveformView.prototype._invalidate = function () {
    if (this._baseQueued) return;
    this._baseQueued = true;
    var self = this;
    requestAnimationFrame(function () {
      self._baseQueued = false;
      if (!self._baseDirty) return;
      self._rebuildBase();
      self.draw();
    });
  };

  WaveformView.prototype._rebuildBase = function () {
    this._baseDirty = false;
    this._renderBase(this._baseCtx);
  };

  WaveformView.prototype._laneArea = function () {
    var top = RULER_H + OVERVIEW_H + GAP;
    var h = this._height - top - GAP;
    if (this.numChannels <= 0) return { top: top, lanes: [] };
    var laneH = (h - LANE_GAP * (this.numChannels - 1)) / this.numChannels;
    var lanes = [];
    for (var c = 0; c < this.numChannels; c++) {
      lanes.push({
        top: top + c * (laneH + LANE_GAP),
        height: laneH
      });
    }
    return { top: top, lanes: lanes };
  };

  WaveformView.prototype._timeToX = function (t) {
    var span = Math.max(this.viewEnd - this.viewStart, 1e-9);
    return (t - this.viewStart) / span * this._width;
  };

  WaveformView.prototype._xToTime = function (x) {
    var span = Math.max(this.viewEnd - this.viewStart, 1e-9);
    return this.viewStart + x / this._width * span;
  };

  /* ---------------- 视口操作 ---------------- */

  WaveformView.prototype._clampView = function () {
    if (!(this.duration > 0)) { this.viewStart = 0; this.viewEnd = 1; return; }
    var span = this.viewEnd - this.viewStart;
    var maxSpan = this.duration;
    if (span > maxSpan) span = maxSpan;
    // 最小窗口：至少包含约 128 个金字塔基础块，避免超过数据精度后空转
    var minSpan = 128 * this.pyramid.blockSize / (this._sampleRateHint || 44100);
    if (!isFinite(minSpan) || minSpan <= 0) minSpan = maxSpan / 1e6;
    if (span < minSpan) span = minSpan;
    var start = clamp(this.viewStart, 0, maxSpan - span);
    this.viewStart = start;
    this.viewEnd = start + span;
  };

  WaveformView.prototype.setSampleRateHint = function (sr) {
    this._sampleRateHint = sr;
  };

  WaveformView.prototype.zoomBy = function (factor, centerX) {
    if (!(this.duration > 0)) return;
    var anchor = this._xToTime(centerX);
    var span = this.viewEnd - this.viewStart;
    var newSpan = clamp(span * factor,
      128 * this.pyramid.blockSize / (this._sampleRateHint || 44100),
      this.duration);
    if (!isFinite(newSpan) || newSpan <= 0) newSpan = span;
    var ratio = centerX / this._width;
    var newStart = anchor - ratio * newSpan;
    this.viewStart = newStart;
    this.viewEnd = newStart + newSpan;
    this._clampView();
    this._invalidate();
  };

  WaveformView.prototype.panBy = function (fraction) {
    if (!(this.duration > 0)) return;
    var span = this.viewEnd - this.viewStart;
    this.viewStart += fraction * span;
    this.viewEnd = this.viewStart + span;
    this._clampView();
    this._invalidate();
  };

  WaveformView.prototype.scrollToTime = function (t) {
    var span = this.viewEnd - this.viewStart;
    // 播放头越过右边缘才滚动；左边缘不做强制滚动
    if (t < this.viewEnd && t >= this.viewStart) return;
    this.viewStart = t - span * 0.3;
    this.viewEnd = this.viewStart + span;
    this._clampView();
    this._invalidate();
  };

  WaveformView.prototype.frameAll = function () {
    this.viewStart = 0;
    this.viewEnd = this.duration;
    this._invalidate();
  };

  /* ---------------- 事件绑定 ---------------- */

  WaveformView.prototype._bindEvents = function () {
    var self = this;
    var canvas = this.canvas;

    canvas.addEventListener('wheel', function (ev) {
      if (!self.duration) return;
      ev.preventDefault();
      var rect = canvas.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY) && !ev.ctrlKey) {
        var dir = ev.shiftKey ? ev.deltaY : ev.deltaX;
        self.panBy((dir > 0 ? 1 : -1) * 0.08 * (ev.deltaMode === 1 ? 3 : 1));
      } else {
        var factor = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
        self.zoomBy(factor, x);
      }
    }, { passive: false });

    canvas.addEventListener('pointerdown', function (ev) {
      if (!self.duration) return;
      canvas.setPointerCapture(ev.pointerId);
      var rect = canvas.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var y = ev.clientY - rect.top;
      var t = self._xToTime(x);

      if (y < RULER_H + OVERVIEW_H && y > RULER_H) {
        // 总览条：点击跳转视口位置
        self._jumpOverview(x);
        self._drag = { mode: 'overview' };
        return;
      }

      if (self.selection) {
        var edge = self._hitSelectionEdge(x);
        if (edge === 'start' || edge === 'end') {
          self._drag = { mode: 'edge', edge: edge };
          return;
        }
      }

      self.setCursor(t);
      self.setSelection(t, t);
      self._drag = { mode: 'select', anchor: t, moved: false };
      if (self._onSeek) self._onSeek(t);
    });

    canvas.addEventListener('pointermove', function (ev) {
      if (!self._drag || !self.duration) return;
      var rect = canvas.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var t = clamp(self._xToTime(x), 0, self.duration);

      if (self._drag.mode === 'select') {
        self._drag.moved = true;
        var a = self._drag.anchor;
        self.setSelection(Math.min(a, t), Math.max(a, t));
      } else if (self._drag.mode === 'edge') {
        var sel = self.selection || { start: 0, end: 0 };
        if (self._drag.edge === 'start') {
          self.setSelection(Math.min(t, sel.end - 1e-6), sel.end);
        } else {
          self.setSelection(sel.start, Math.max(t, sel.start + 1e-6));
        }
      } else if (self._drag.mode === 'overview') {
        self._jumpOverview(x);
      }
    });

    var endDrag = function (ev) {
      if (!self._drag) return;
      if (self._drag.mode === 'select' && !self._drag.moved && self.selection) {
        // 单击：清除选区，只保留光标
        self.selection = null;
        self._invalidate();
        if (self._onSelectionChange) self._onSelectionChange(null);
      } else if (self._drag.mode === 'select' && self.selection &&
                 self.selection.end - self.selection.start < 0.0005) {
        self.selection = null;
        self._invalidate();
        if (self._onSelectionChange) self._onSelectionChange(null);
      }
      self._drag = null;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('dblclick', function () {
      self.selection = null;
      self.draw();
      if (self._onSelectionChange) self._onSelectionChange(null);
    });

    this._resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(function () { self.resize(); });
      this._resizeObserver.observe(canvas.parentElement);
    } else {
      window.addEventListener('resize', function () { self.resize(); });
    }
  };

  WaveformView.prototype._hitSelectionEdge = function (x) {
    if (!this.selection) return null;
    var xs = this._timeToX(this.selection.start);
    var xe = this._timeToX(this.selection.end);
    var tol = 6;
    if (Math.abs(x - xs) <= tol) return 'start';
    if (Math.abs(x - xe) <= tol) return 'end';
    return null;
  };

  WaveformView.prototype._jumpOverview = function (x) {
    var span = this.viewEnd - this.viewStart;
    var ratio = clamp(x / this._width, 0, 1);
    var center = ratio * this.duration;
    this.viewStart = clamp(center - span / 2, 0, this.duration - span);
    this.viewEnd = this.viewStart + span;
    this._invalidate();
  };

/* ---------------- 绘制 ---------------- */

var NICE_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05,
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 1800, 3600
];

function chooseTimeStep(pxPerSec) {
  var target = 100; // 期望主刻度间隔约 100px
  for (var i = 0; i < NICE_STEPS.length; i++) {
    if (NICE_STEPS[i] * pxPerSec >= target) return NICE_STEPS[i];
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}

function formatTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  var h = Math.floor(t / 3600);
  var m = Math.floor((t % 3600) / 60);
  var s = t % 60;
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var ss = (s < 10 ? '0' : '') + s.toFixed(3);
  if (h > 0) return h + ':' + pad(m) + ':' + ss;
  return pad(m) + ':' + ss;
}

WaveformView.prototype._renderBase = function (ctx) {
  var w = this._width;
  var h = this._height;
  if (w < 2 || h < 2) return;

  ctx.fillStyle = '#14171c';
  ctx.fillRect(0, 0, w, h);

  this._drawRuler(ctx, w);
  this._drawOverview(ctx, w);

  var area = this._laneArea();
  if (this.numChannels > 0) {
    for (var c = 0; c < area.lanes.length; c++) {
      this._drawLaneBackground(ctx, area.lanes[c], c, area.lanes.length);
    }
    for (var ch = 0; ch < area.lanes.length; ch++) {
      this._drawWaveform(ctx, area.lanes[ch], ch);
    }
    this._drawSelection(ctx, area.lanes);
    for (var ch2 = 0; ch2 < area.lanes.length; ch2++) {
      this._drawChannelLabel(ctx, area.lanes[ch2], ch2);
    }
  } else {
    this._drawIdleState(ctx, area);
  }
};

/**
 * 每帧绘制：直接 blit 离屏底层，仅在其上叠加播放头。
 * 播放期间约 60fps 调用，开销与波形采样数无关。
 */
WaveformView.prototype.draw = function () {
  if (this._baseDirty) this._rebuildBase();
  var ctx = this.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  ctx.drawImage(this._baseCanvas, 0, 0);
  ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
  this._drawOverviewPlayhead(ctx);
  this._drawPlayhead(ctx, this._laneArea().lanes);
};

WaveformView.prototype._drawRuler = function (ctx, w) {
  ctx.fillStyle = '#1d2129';
  ctx.fillRect(0, 0, w, RULER_H);
  ctx.strokeStyle = '#343c4a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_H + 0.5);
  ctx.lineTo(w, RULER_H + 0.5);
  ctx.stroke();

  if (!this.duration) return;

  var span = this.viewEnd - this.viewStart;
  var pxPerSec = w / span;
  var step = chooseTimeStep(pxPerSec);
  var sub = step / 5;
  var first = Math.floor(this.viewStart / sub) * sub;

  ctx.textBaseline = 'top';
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

  for (var t = first; t <= this.viewEnd + sub; t += sub) {
    if (t < this.viewStart - sub) continue;
    var x = Math.round(this._timeToX(t)) + 0.5;
    var isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ctx.strokeStyle = isMajor ? '#5a6577' : '#333b49';
    ctx.beginPath();
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, isMajor ? RULER_H - 7 : RULER_H - 4);
    ctx.stroke();
    if (isMajor && x > 2 && x < w - 48) {
      ctx.fillStyle = '#9aa5b5';
      ctx.fillText(formatTime(t), x + 4, 5);
    }
  }
};

WaveformView.prototype._drawOverview = function (ctx, w) {
  var top = RULER_H;
  ctx.fillStyle = '#191d24';
  ctx.fillRect(0, top, w, OVERVIEW_H);
  ctx.strokeStyle = '#343c4a';
  ctx.beginPath();
  ctx.moveTo(0, top + OVERVIEW_H + 0.5);
  ctx.lineTo(w, top + OVERVIEW_H + 0.5);
  ctx.stroke();

  if (!this.duration || !this.pyramid) return;

  // 总览使用最高层（块数最少），多声道合并
  var topLevel = this.pyramid.levels[this.pyramid.levels.length - 1];
  var blocks = topLevel[0].min.length;
  var mid = top + OVERVIEW_H / 2;
  var amp = OVERVIEW_H / 2 - 5;

  ctx.fillStyle = '#3d5a86';
  for (var i = 0; i < blocks; i++) {
    var mn = Infinity, mx = -Infinity;
    for (var c = 0; c < topLevel.length; c++) {
      if (topLevel[c].min[i] < mn) mn = topLevel[c].min[i];
      if (topLevel[c].max[i] > mx) mx = topLevel[c].max[i];
    }
    var x0 = i / blocks * w;
    var bw = Math.max(1, w / blocks);
    var y1 = mid - mx * amp;
    var y2 = mid - mn * amp;
    ctx.fillRect(x0, y1, bw, Math.max(1, y2 - y1));
  }

  // 视口框
  var vs = this.viewStart / this.duration * w;
  var ve = this.viewEnd / this.duration * w;
  ctx.fillStyle = 'rgba(76, 141, 255, 0.18)';
  ctx.fillRect(vs, top, ve - vs, OVERVIEW_H);
  ctx.strokeStyle = 'rgba(120, 170, 255, 0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(vs + 0.5, top + 0.5, ve - vs - 1, OVERVIEW_H - 1);

}

WaveformView.prototype._drawOverviewPlayhead = function (ctx) {
  if (this.playhead === null || !this.duration) return;
  var px = this.playhead / this.duration * this._width;
  var top = RULER_H;
  ctx.strokeStyle = '#ffd34d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px + 0.5, top);
  ctx.lineTo(px + 0.5, top + OVERVIEW_H);
  ctx.stroke();
};

WaveformView.prototype._drawLaneBackground = function (ctx, lane, idx, total) {
  ctx.fillStyle = idx % 2 === 0 ? '#171b21' : '#151920';
  ctx.fillRect(0, lane.top, this._width, lane.height);
  var mid = lane.top + lane.height / 2;
  ctx.strokeStyle = '#272e39';
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(this._width, mid + 0.5);
  ctx.stroke();
};

WaveformView.prototype._drawChannelLabel = function (ctx, lane, idx) {
  var label = this.numChannels > 1 ? ('CH ' + (idx + 1)) : 'L/R';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(154, 165, 181, 0.85)';
  ctx.fillText(label, 6, lane.top + 4);
};

WaveformView.prototype._drawIdleState = function (ctx) {
  // 空状态由 HTML 覆盖层提示，这里不额外绘制
};

WaveformView.prototype._pickLevel = function () {
  // 选「每像素对应采样数」最接近且 <= 的层级（保证块数多于像素，不丢峰）
  var sr = this._sampleRateHint || 44100;
  var span = this.viewEnd - this.viewStart;
  var samplesPerPixel = span * sr / this._width;
  var levels = this.pyramid.levels;
  var chosen = 0;
  for (var k = 0; k < levels.length; k++) {
    var blockSamples = this.pyramid.blockSize * Math.pow(this.pyramid.factor, k);
    if (blockSamples <= samplesPerPixel) chosen = k;
  }
  return chosen;
};

WaveformView.prototype._drawWaveform = function (ctx, lane, channel) {
  if (!this.pyramid) return;
  var sr = this._sampleRateHint || 44100;
  var levelIdx = this._pickLevel();
  var level = this.pyramid.levels[levelIdx][channel];
  var blockSamples = this.pyramid.blockSize * Math.pow(this.pyramid.factor, levelIdx);
  var secPerBlock = blockSamples / sr;

  var firstBlock = Math.floor(this.viewStart / secPerBlock);
  var lastBlock = Math.ceil(this.viewEnd / secPerBlock);
  firstBlock = Math.max(0, firstBlock);
  lastBlock = Math.min(level.min.length - 1, lastBlock);
  if (lastBlock < firstBlock) return;

  var mid = lane.top + lane.height / 2;
  var amp = lane.height / 2 - 3;
  var span = this.viewEnd - this.viewStart;
  var pxPerSec = this._width / span;
  var blockPx = secPerBlock * pxPerSec;
  var rectW = Math.max(1, Math.ceil(blockPx) + 1);

  var sel = this.selection;
  ctx.fillStyle = '#5da2ff';

  for (var i = firstBlock; i <= lastBlock; i++) {
    var t = i * secPerBlock;
    var x = (t - this.viewStart) * pxPerSec;
    if (x > this._width) break;
    var mn = level.min[i];
    var mx = level.max[i];

    if (sel) {
      var blockEnd = t + secPerBlock;
      if (blockEnd <= sel.start || t >= sel.end) {
        ctx.fillStyle = '#5da2ff';
      } else {
        ctx.fillStyle = '#9cc4ff';
      }
    } else {
      ctx.fillStyle = '#5da2ff';
    }

    var y1 = mid - mx * amp;
    var y2 = mid - mn * amp;
    if (y2 - y1 < 1) {
      y1 = mid - 0.5;
      y2 = mid + 0.5;
    }
    ctx.fillRect(x, y1, rectW, y2 - y1);
  }
};

WaveformView.prototype._drawSelection = function (ctx, lanes) {
  if (!this.selection || lanes.length === 0) return;
  var sel = this.selection;
  var x1 = this._timeToX(sel.start);
  var x2 = this._timeToX(sel.end);
  var top = lanes[0].top;
  var last = lanes[lanes.length - 1];
  var bottom = last.top + last.height;

  // 选区在标尺上的遮罩
  ctx.fillStyle = 'rgba(76,141,255,0.16)';
  ctx.fillRect(x1, 0, x2 - x1, RULER_H);

  ctx.fillStyle = 'rgba(76, 141, 255, 0.20)';
  ctx.fillRect(x1, top, x2 - x1, bottom - top);

  ctx.strokeStyle = 'rgba(150, 190, 255, 0.95)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#9cbfff';
  ctx.beginPath();
  ctx.moveTo(x1, bottom);
  ctx.lineTo(x1, top);
  ctx.moveTo(x2, top);
  ctx.lineTo(x2, bottom);
  ctx.stroke();

  // 边缘把手（标尺上的小三角）
  this._drawEdgeHandle(ctx, x1, true);
  this._drawEdgeHandle(ctx, x2, false);
};

WaveformView.prototype._drawEdgeHandle = function (ctx, x, leftSide) {
  var y = RULER_H;
  var s = 5;
  ctx.beginPath();
  if (leftSide) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x + s, y - s);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x - s, y);
    ctx.lineTo(x - s, y - s);
  }
  ctx.closePath();
  ctx.fill();
};

WaveformView.prototype._drawPlayhead = function (ctx, lanes) {
  if (this.playhead === null) return;
  var x = this._timeToX(this.playhead);
  var top = 0;
  var bottom = this._height;
  if (lanes.length > 0) {
    top = lanes[0].top;
    var last = lanes[lanes.length - 1];
    bottom = last.top + last.height;
  }
  ctx.strokeStyle = '#ffd34d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, top);
  ctx.lineTo(x + 0.5, bottom);
  ctx.stroke();

  // 标尺三角
  ctx.fillStyle = '#ffd34d';
  ctx.beginPath();
  ctx.moveTo(x - 5, 0);
  ctx.lineTo(x + 5, 0);
  ctx.lineTo(x, 7);
  ctx.closePath();
  ctx.fill();
};


  global.WaveformView = WaveformView;
  WaveformView.formatTime = formatTime;
})(window);

import { clamp, resamplePeaks } from './audio-utils.js';

const RULER_HEIGHT = 34;
const HANDLE_WIDTH = 10;
const HIT_PADDING = 12;

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

export class WaveformView {
  constructor(waveCanvas, overlayCanvas, callbacks = {}) {
    this.waveCanvas = waveCanvas;
    this.overlayCanvas = overlayCanvas;
    this.callbacks = callbacks;
    this.context = waveCanvas.getContext('2d');
    this.overlayContext = overlayCanvas.getContext('2d');
    if (!this.context || !this.overlayContext) {
      throw new Error('当前浏览器不支持 Canvas 2D 绘制');
    }

    this.state = {
      durationFrames: 0,
      startFrame: 0,
      endFrame: 0,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      playheadFrame: 0,
      durationSeconds: 0,
      peaks: null,
      hasAudio: false
    };
    this.width = 0;
    this.height = 0;
    this.drag = null;
    this.raf = 0;
    this.resizedPeaks = null;
    this.bindEvents();
  }

  bindEvents() {
    this.waveCanvas.addEventListener('pointerdown', (event) => this.handlePointerDown(event));
    this.waveCanvas.addEventListener('pointermove', (event) => this.handlePointerMove(event));
    window.addEventListener('pointerup', (event) => this.handlePointerUp(event));
    this.waveCanvas.addEventListener('dblclick', (event) => {
      const frame = this.frameAt(event.offsetX);
      if (frame !== null && this.callbacks.onSeekPlay) this.callbacks.onSeekPlay(frame);
    });
  }

  resize() {
    const rect = this.waveCanvas.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === this.width && height === this.height) return width;

    for (const canvas of [this.waveCanvas, this.overlayCanvas]) {
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
    }
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.overlayContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.width = width;
    this.height = height;
    this.resizedPeaks = null;
    this.drawStatic();
    this.scheduleOverlay();
    return width;
  }

  getCssWidth() {
    return this.width || Math.max(1, Math.round(this.waveCanvas.getBoundingClientRect().width));
  }

  setState(patch, options = {}) {
    const redraw = options.redraw !== false;
    this.state = { ...this.state, ...patch };
    if (this.state.hasAudio) {
      this.state.startFrame = clamp(this.state.startFrame, 0, this.state.durationFrames);
      this.state.endFrame = clamp(this.state.endFrame, 0, this.state.durationFrames);
      if (this.state.endFrame <= this.state.startFrame) {
        this.state.endFrame = Math.min(this.state.durationFrames, this.state.startFrame + 1);
      }
      const maximumFade = Math.floor((this.state.endFrame - this.state.startFrame) / 2);
      this.state.fadeInFrames = clamp(this.state.fadeInFrames, 0, maximumFade);
      this.state.fadeOutFrames = clamp(this.state.fadeOutFrames, 0, maximumFade);
      this.state.playheadFrame = clamp(this.state.playheadFrame, 0, this.state.durationFrames);
    }
    this.resizedPeaks = null;
    if (redraw) {
      this.drawStatic();
      this.scheduleOverlay();
    }
  }

  setPlayhead(frame) {
    this.state.playheadFrame = clamp(frame, 0, this.state.durationFrames);
    this.scheduleOverlay();
  }

  xForFrame(frame) {
    if (!this.state.durationFrames) return 0;
    return (frame / this.state.durationFrames) * this.getCssWidth();
  }

  frameAt(offsetX) {
    if (!this.state.hasAudio || !this.state.durationFrames) return null;
    const ratio = clamp(offsetX / this.getCssWidth(), 0, 1);
    return Math.round(ratio * this.state.durationFrames);
  }

  getHandles() {
    return [
      { type: 'start', x: this.xForFrame(this.state.startFrame) },
      { type: 'fadeIn', x: this.xForFrame(this.state.startFrame + this.state.fadeInFrames) },
      { type: 'fadeOut', x: this.xForFrame(this.state.endFrame - this.state.fadeOutFrames) },
      { type: 'end', x: this.xForFrame(this.state.endFrame) }
    ];
  }

  hitTest(x, y) {
    if (y < RULER_HEIGHT - HIT_PADDING) return null;
    const handles = this.getHandles().sort((left, right) => Math.abs(x - right.x) - Math.abs(x - left.x));
    for (const handle of handles) {
      if (Math.abs(x - handle.x) <= HIT_PADDING) return handle.type;
    }
    return null;
  }

  getVisiblePeaks() {
    if (!this.state.peaks) return null;
    const targetBins = Math.min(this.getCssWidth(), this.state.peaks.frameCount);
    if (
      this.resizedPeaks &&
      this.resizedPeaks.sourceBins === this.state.peaks.bins &&
      this.resizedPeaks.targetBins === targetBins
    ) {
      return this.resizedPeaks;
    }
    const result = resamplePeaks(this.state.peaks.mins, this.state.peaks.maxs, targetBins);
    this.resizedPeaks = { ...result, sourceBins: this.state.peaks.bins, targetBins };
    return this.resizedPeaks;
  }

  drawRuler(ctx, duration) {
    const width = this.getCssWidth();
    ctx.fillStyle = '#0b1424';
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    ctx.strokeStyle = '#263650';
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT + 0.5);
    ctx.lineTo(width, RULER_HEIGHT + 0.5);
    ctx.stroke();

    const targetTicks = Math.max(4, Math.floor(width / 120));
    const roughStep = duration / targetTicks;
    const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    const step = candidates.find((value) => value >= roughStep) || roughStep;
    ctx.fillStyle = '#8da4c4';
    ctx.font = '12px ui-sans-serif, system-ui';
    ctx.textBaseline = 'middle';

    for (let time = 0; time <= duration + 0.0001; time += step) {
      const x = (time / duration) * width;
      ctx.strokeStyle = '#263650';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_HEIGHT - 8);
      ctx.lineTo(x + 0.5, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(formatTime(time), x + 5, RULER_HEIGHT / 2);
    }
  }

  drawFadeEnvelope(ctx, fromX, toX, direction, top, bottom) {
    if (toX <= fromX) return;
    ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
    ctx.beginPath();
    if (direction === 'in') {
      ctx.moveTo(fromX, bottom);
      ctx.lineTo(toX, top);
      ctx.lineTo(toX, bottom);
    } else {
      ctx.moveTo(fromX, top);
      ctx.lineTo(toX, bottom);
      ctx.lineTo(fromX, bottom);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(251, 191, 36, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (direction === 'in') {
      ctx.moveTo(fromX, bottom);
      ctx.lineTo(toX, top);
    } else {
      ctx.moveTo(fromX, top);
      ctx.lineTo(toX, bottom);
    }
    ctx.stroke();
  }

  drawHandle(ctx, x, color, title) {
    const top = RULER_HEIGHT;
    const bottom = this.height;
    ctx.fillStyle = color;
    ctx.fillRect(x - HANDLE_WIDTH / 2, top, HANDLE_WIDTH, bottom - top);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.strokeRect(x - HANDLE_WIDTH / 2 + 0.5, top + 0.5, HANDLE_WIDTH - 1, bottom - top - 1);
    ctx.beginPath();
    ctx.moveTo(x - 4, (top + bottom) / 2 - 8);
    ctx.lineTo(x + 4, (top + bottom) / 2 - 8);
    ctx.moveTo(x - 4, (top + bottom) / 2 + 8);
    ctx.lineTo(x + 4, (top + bottom) / 2 + 8);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
  }

  drawStatic() {
    const ctx = this.context;
    const width = this.getCssWidth();
    const height = this.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#070d18';
    ctx.fillRect(0, 0, width, height);
    if (!this.state.hasAudio || !this.state.peaks) return;

    const duration = this.state.durationSeconds || this.state.durationFrames || 1;
    this.drawRuler(ctx, duration);
    const peaks = this.getVisiblePeaks();
    const startX = this.xForFrame(this.state.startFrame);
    const endX = this.xForFrame(this.state.endFrame);
    const center = (RULER_HEIGHT + height) / 2;
    const amplitude = (height - RULER_HEIGHT) / 2 - 8;

    ctx.fillStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.fillRect(startX, RULER_HEIGHT, Math.max(0, endX - startX), height - RULER_HEIGHT);

    const binWidth = width / peaks.mins.length;
    for (let bin = 0; bin < peaks.mins.length; bin += 1) {
      const x = (bin + 0.5) * binWidth;
      const low = center + peaks.mins[bin] * amplitude;
      const high = center - peaks.maxs[bin] * amplitude;
      const selected = x >= startX && x <= endX;
      ctx.strokeStyle = selected ? '#60a5fa' : '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, low);
      ctx.lineTo(x, high);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.beginPath();
    ctx.moveTo(0, center + 0.5);
    ctx.lineTo(width, center + 0.5);
    ctx.stroke();

    const waveTop = RULER_HEIGHT + 8;
    const waveBottom = height - 8;
    const fadeInX = this.xForFrame(this.state.startFrame + this.state.fadeInFrames);
    const fadeOutX = this.xForFrame(this.state.endFrame - this.state.fadeOutFrames);
    this.drawFadeEnvelope(ctx, startX, fadeInX, 'in', waveTop, waveBottom);
    this.drawFadeEnvelope(ctx, fadeOutX, endX, 'out', waveTop, waveBottom);

    this.drawHandle(ctx, startX, '#38bdf8', '裁剪起点');
    this.drawHandle(ctx, fadeInX, '#fbbf24', '淡入终点');
    this.drawHandle(ctx, fadeOutX, '#fbbf24', '淡出起点');
    this.drawHandle(ctx, endX, '#38bdf8', '裁剪终点');
  }

  scheduleOverlay() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.drawOverlay();
    });
  }

  drawOverlay() {
    const ctx = this.overlayContext;
    const width = this.getCssWidth();
    const height = this.height;
    ctx.clearRect(0, 0, width, height);
    if (!this.state.hasAudio) return;
    const x = this.xForFrame(this.state.playheadFrame);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x - 6, 10);
    ctx.lineTo(x + 6, 10);
    ctx.closePath();
    ctx.fill();
  }

  handlePointerDown(event) {
    if (!this.state.hasAudio) return;
    const rect = this.waveCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const handle = this.hitTest(x, y);
    if (!handle) return;

    event.preventDefault();
    this.waveCanvas.setPointerCapture(event.pointerId);
    this.drag = {
      handle,
      pointerId: event.pointerId,
      startX: x
    };
    if (this.callbacks.onEditStart) this.callbacks.onEditStart();
    this.emitDrag(x);
  }

  handlePointerMove(event) {
    if (!this.state.hasAudio) return;
    const rect = this.waveCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (this.drag && this.drag.pointerId === event.pointerId) {
      event.preventDefault();
      this.emitDrag(x);
      return;
    }

    const handle = this.hitTest(x, y);
    this.waveCanvas.style.cursor = handle ? 'ew-resize' : 'default';
  }

  handlePointerUp(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    const pointerId = this.drag.pointerId;
    this.drag = null;
    if (this.waveCanvas.hasPointerCapture(pointerId)) {
      this.waveCanvas.releasePointerCapture(pointerId);
    }
    if (this.callbacks.onEditEnd) this.callbacks.onEditEnd();
  }

  emitDrag(x) {
    if (!this.drag || !this.callbacks.onEdit) return;
    const frame = this.frameAt(x);
    if (frame === null) return;
    const selectedFrames = this.state.endFrame - this.state.startFrame;
    const maximumFade = Math.floor(selectedFrames / 2);
    const patch = {};

    if (this.drag.handle === 'start') {
      patch.startFrame = clamp(frame, 0, this.state.endFrame - 1);
      patch.fadeInFrames = clamp(this.state.fadeInFrames, 0, maximumFade);
      patch.fadeOutFrames = clamp(this.state.fadeOutFrames, 0, maximumFade);
    } else if (this.drag.handle === 'end') {
      patch.endFrame = clamp(frame, this.state.startFrame + 1, this.state.durationFrames);
      patch.fadeInFrames = clamp(this.state.fadeInFrames, 0, maximumFade);
      patch.fadeOutFrames = clamp(this.state.fadeOutFrames, 0, maximumFade);
    } else if (this.drag.handle === 'fadeIn') {
      patch.fadeInFrames = clamp(
        frame - this.state.startFrame,
        0,
        Math.min(maximumFade, this.state.endFrame - this.state.startFrame - this.state.fadeOutFrames)
      );
    } else if (this.drag.handle === 'fadeOut') {
      patch.fadeOutFrames = clamp(
        this.state.endFrame - frame,
        0,
        Math.min(maximumFade, this.state.endFrame - this.state.startFrame - this.state.fadeInFrames)
      );
    }

    this.callbacks.onEdit(patch);
  }
}

/*
 * engine.js — Web Audio 播放引擎（解码 + BufferSource 播放/暂停/停止）。
 */
(function (global) {
  'use strict';

  function AudioEngine() {
    this._ctx = null;
    this._source = null;
    this._buffer = null;
    this._startCtxTime = 0;
    this._startOffset = 0;
    this._stopAt = null; // 自然停止的时间点（秒），用于选区播放
    this._playing = false;
    this._manualStop = false;
    this._onEnded = null;
  }

  AudioEngine.prototype.ensureContext = function () {
    if (!this._ctx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('当前浏览器不支持 Web Audio API');
      this._ctx = new Ctx();
    }
    if (this._ctx.state === 'suspended') {
      return this._ctx.resume().catch(function (err) {
        throw new Error('音频上下文无法启动: ' + (err && err.message ? err.message : err));
      });
    }
    return Promise.resolve(this._ctx);
  };

  Object.defineProperty(AudioEngine.prototype, 'sampleRate', {
    get: function () { return this._ctx ? this._ctx.sampleRate : 0; }
  });

  AudioEngine.prototype.decode = function (arrayBuffer) {
    var self = this;
    return this.ensureContext().then(function (ctx) {
      // decodeAudioData 会消耗/转移传入的 buffer，先复制一份保留原数据
      var copy = arrayBuffer.slice(0);
      return ctx.decodeAudioData(copy).then(
        function (buffer) { return buffer; },
        function (err) {
          var msg = err && err.message ? err.message : '未知原因';
          var e = new Error('音频解码失败：浏览器无法识别该格式或文件已损坏（' + msg + '）');
          e.cause = err;
          throw e;
        }
      );
    });
  };

  AudioEngine.prototype.createBuffer = function (channels, sampleRate) {
    var ctx = this._ctx;
    if (!ctx) throw new Error('音频上下文尚未初始化');
    var frames = channels[0].length;
    var buffer = ctx.createBuffer(channels.length, frames, sampleRate);
    for (var c = 0; c < channels.length; c++) {
      buffer.getChannelData(c).set(channels[c]);
    }
    return buffer;
  };

  AudioEngine.prototype.setBuffer = function (buffer) {
    this.stop();
    this._buffer = buffer;
  };

  AudioEngine.prototype.getPosition = function () {
    if (!this._playing) return this._startOffset;
    var pos = this._ctx.currentTime - this._startCtxTime + this._startOffset;
    if (this._stopAt !== null && pos >= this._stopAt) return this._stopAt;
    return pos;
  };

  Object.defineProperty(AudioEngine.prototype, 'isPlaying', {
    get: function () { return this._playing; }
  });

  AudioEngine.prototype.play = function (from, stopAt, onEnded) {
    if (!this._ctx || !this._buffer) throw new Error('没有可播放的音频');
    this._teardownSource();

    var source = this._ctx.createBufferSource();
    source.buffer = this._buffer;
    source.connect(this._ctx.destination);

    var dur = this._buffer.duration;
    this._startOffset = Math.max(0, Math.min(from || 0, dur));
    this._stopAt = stopAt !== undefined && stopAt !== null
      ? Math.max(this._startOffset, Math.min(stopAt, dur))
      : null;
    this._onEnded = onEnded || null;
    this._manualStop = false;
    this._startCtxTime = this._ctx.currentTime;

    var self = this;
    source.onended = function () {
      if (!self._playing && self._source !== source) return;
      var reachedEnd = self._stopAt !== null
        ? self.getPosition() >= self._stopAt - 1e-4
        : true;
      self._playing = false;
      self._source = null;
      if (self._manualStop) return;
      if (self._onEnded) {
        var endPos = self._stopAt !== null ? self._stopAt : self._buffer.duration;
        self._startOffset = endPos;
        self._onEnded(endPos, reachedEnd);
      }
    };

    this._source = source;
    this._playing = true;
    if (this._stopAt !== null) {
      source.start(0, this._startOffset, this._stopAt - this._startOffset);
    } else {
      source.start(0, this._startOffset);
    }
  };

  AudioEngine.prototype.pause = function () {
    if (!this._playing) return this._startOffset;
    var pos = this.getPosition();
    this._manualStop = true;
    this._teardownSource();
    this._playing = false;
    this._startOffset = pos;
    return pos;
  };

  AudioEngine.prototype.stop = function () {
    this._manualStop = true;
    this._teardownSource();
    this._playing = false;
    this._startOffset = 0;
    this._stopAt = null;
  };

  AudioEngine.prototype._teardownSource = function () {
    if (this._source) {
      try { this._source.onended = null; this._source.stop(); } catch (e) {}
      try { this._source.disconnect(); } catch (e) {}
      this._source = null;
    }
  };

  global.AudioEngine = AudioEngine;
})(window);

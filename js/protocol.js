/*
 * protocol.js — 主线程与 Web Worker 之间的消息协议与客户端。
 * Worker 不可用时自动降级为「异步主线程执行」并给出警告标志。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./dsp.js'));
  } else {
    root.DspProtocol = factory(root.DSP);
  }
})(typeof self !== 'undefined' ? self : this, function (DSP) {
  'use strict';

  function transferOfPyramid(p) {
    var list = [];
    for (var i = 0; i < p.levels.length; i++) {
      var level = p.levels[i];
      for (var c = 0; c < level.length; c++) {
        list.push(level[c].min.buffer, level[c].max.buffer);
      }
    }
    return list;
  }

  function transferOfChannels(channels) {
    return channels.map(function (ch) { return ch.buffer; });
  }

  /** 纯计算入口：输入请求消息，返回响应消息（不含传输列表处理）。 */
  function handleRequest(msg) {
    switch (msg.type) {
      case 'buildPyramid': {
        var p = DSP.buildPyramid(msg.channels, msg.samplesPerBlock | 0);
        return {
          type: 'pyramid',
          id: msg.id,
          levels: p.levels,
          blockSize: p.blockSize,
          factor: p.factor,
          frames: p.frames,
          _transfer: transferOfPyramid(p)
        };
      }
      case 'edit': {
        var out;
        var s = msg.startFrame | 0;
        var e = msg.endFrame | 0;
        switch (msg.action) {
          case 'crop':
            out = DSP.cropChannels(msg.channels, s, e);
            break;
          case 'delete':
            out = DSP.deleteRange(msg.channels, s, e);
            break;
          case 'fadeIn':
            out = DSP.applyFade(msg.channels, s, e, 'in');
            break;
          case 'fadeOut':
            out = DSP.applyFade(msg.channels, s, e, 'out');
            break;
          default:
            throw new Error('未知编辑动作: ' + msg.action);
        }
        return {
          type: 'edited',
          id: msg.id,
          action: msg.action,
          channels: out,
          _transfer: transferOfChannels(out)
        };
      }
      case 'export': {
        var wav = DSP.encodeWav(msg.channels, msg.sampleRate | 0);
        return {
          type: 'exported',
          id: msg.id,
          wav: wav,
          _transfer: [wav]
        };
      }
      default:
        throw new Error('未知消息类型: ' + msg.type);
    }
  }

  /* ---------------- 客户端（主线程） ---------------- */

  function DspClient(workerUrl) {
    this._seq = 0;
    this._pending = Object.create(null);
    this.mode = 'worker';
    this._worker = null;
    this._everResponded = false;

    var self = this;
    try {
      if (typeof Worker === 'undefined') throw new Error('当前环境不支持 Web Worker');
      this._worker = new Worker(workerUrl || 'js/dsp-worker.js');
      this._worker.onmessage = function (ev) {
        self._everResponded = true;
        self._onMessage(ev.data);
      };
      // Worker 脚本加载失败/运行崩溃：尚无成功响应时降级到主线程，
      // 已正常工作后崩溃则拒绝当前请求。
      this._worker.onerror = function (ev) {
        var message = ev && ev.message ? ev.message : '未知错误';
        if (!self._everResponded) {
          self._switchToMain('Worker 加载失败（' + message + '），已降级为主线程计算');
        } else {
          self._failAll('Worker 内部错误: ' + message);
        }
      };
    } catch (err) {
      this._switchToMain(err && err.message ? err.message : String(err));
    }
  }

  DspClient.prototype._switchToMain = function (reason) {
    this.mode = 'main-thread';
    this._fallbackError = reason;
    if (this._worker) {
      try { this._worker.terminate(); } catch (e) {}
      this._worker = null;
    }
    // 已排队的请求改由主线程异步执行
    this._retryPendingOnMain();
  };

  DspClient.prototype._failAll = function (message) {
    var pending = this._pending;
    this._pending = Object.create(null);
    Object.keys(pending).forEach(function (key) {
      pending[key].reject(new Error(message));
    });
  };

  DspClient.prototype._retryPendingOnMain = function () {
    // 保留 this._pending，结果回来时由 _onMessage 兑现 Promise
    var ids = Object.keys(this._pending);
    var self = this;
    ids.forEach(function (key) {
      var id = Number(key);
      var msg = self._pending[key].msg;
      self._runOnMain(id, msg);
    });
  };

  DspClient.prototype._onMessage = function (data) {
    var entry = this._pending[data.id];
    if (!entry) return;
    delete this._pending[data.id];
    if (data.type === 'error') {
      entry.reject(new Error(data.message || 'DSP 处理失败'));
    } else {
      entry.resolve(data);
    }
  };

  DspClient.prototype._send = function (msg, transfer) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var id = ++self._seq;
      msg.id = id;
      // 深拷贝一份请求用于「Worker 加载失败 -> 主线程重试」：
      // 已 postMessage 的 TypedArray 缓冲会被标记为已转移，不能再次发送
      var retryCopy = cloneMessage(msg);
      self._pending[id] = { resolve: resolve, reject: reject, msg: retryCopy };
      if (self.mode === 'worker') {
        try {
          self._worker.postMessage(msg, transfer || []);
        } catch (err) {
          delete self._pending[id];
          reject(err);
        }
      } else {
        self._runOnMain(id, retryCopy);
      }
    });
  };

  DspClient.prototype._runOnMain = function (id, msg) {
    var self = this;
    setTimeout(function () {
      try {
        var res = handleRequest(msg);
        self._onMessage(stripTransfer(res));
      } catch (err) {
        self._onMessage({ id: id, type: 'error', message: err.message || String(err) });
      }
    }, 0);
  };

  function cloneMessage(msg) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(msg); } catch (e) { /* 回退手动拷贝 */ }
    }
    function cloneChannels(channels) {
      return channels.map(function (ch) {
        var cp = new Float32Array(ch.length);
        cp.set(ch);
        return cp;
      });
    }
    var copy = { type: msg.type, id: msg.id };
    if (msg.type === 'buildPyramid') {
      copy.samplesPerBlock = msg.samplesPerBlock;
      copy.channels = cloneChannels(msg.channels);
    } else if (msg.type === 'edit') {
      copy.action = msg.action;
      copy.startFrame = msg.startFrame;
      copy.endFrame = msg.endFrame;
      copy.channels = cloneChannels(msg.channels);
    } else if (msg.type === 'export') {
      copy.sampleRate = msg.sampleRate;
      copy.channels = cloneChannels(msg.channels);
    }
    return copy;
  }

  DspClient.prototype.buildPyramid = function (channels, samplesPerBlock) {
    // 主声道缓冲还要用于播放/编辑，这里复制一份再转移，避免主线程缓冲失效
    var copies = channels.map(function (ch) {
      var cp = new Float32Array(ch.length);
      cp.set(ch);
      return cp;
    });
    return this._send({
      type: 'buildPyramid',
      channels: copies,
      samplesPerBlock: samplesPerBlock
    }, transferOfChannels(copies));
  };

  DspClient.prototype.edit = function (action, channels, startFrame, endFrame) {
    return this._send({
      type: 'edit',
      action: action,
      channels: channels,
      startFrame: startFrame,
      endFrame: endFrame
    }, transferOfChannels(channels));
  };

  DspClient.prototype.exportWav = function (channels, sampleRate) {
    // 不转移声道缓冲：导出后主缓冲仍需保留，仅转移产出的 WAV
    return this._send({
      type: 'export',
      channels: channels,
      sampleRate: sampleRate
    }, []);
  };

  function stripTransfer(res) {
    if (res && Object.prototype.hasOwnProperty.call(res, '_transfer')) {
      var copy = {};
      Object.keys(res).forEach(function (k) {
        if (k !== '_transfer') copy[k] = res[k];
      });
      return copy;
    }
    return res;
  }

  /* ---------------- Worker 引导 ---------------- */

  function bootWorker(self) {
    self.onmessage = function (ev) {
      var msg = ev.data;
      try {
        var res = handleRequest(msg);
        var transfer = res._transfer || [];
        var clean = stripTransfer(res);
        self.postMessage(clean, transfer);
      } catch (err) {
        self.postMessage({ id: msg && msg.id, type: 'error', message: err.message || String(err) });
      }
    };
  }

  // 在 Dedicated Worker 全局环境中自动注册
  if (typeof document === 'undefined' &&
      typeof self !== 'undefined' &&
      typeof importScripts === 'function') {
    bootWorker(self);
  }

  return {
    DspClient: DspClient,
    handleRequest: handleRequest,
    bootWorker: bootWorker
  };
});

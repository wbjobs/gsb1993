/*
 * app.js — 应用主控：文件载入、编辑、播放、导出、异常提示。
 */
(function () {
  'use strict';

  var SAMPLES_PER_BLOCK = 64;

  var els = {};
  var engine = new AudioEngine();
  var dsp = new DspProtocol.DspClient('js/dsp-worker.js');

  var state = {
    channels: null,
    sampleRate: 0,
    pyramid: null,
    duration: 0,
    busy: false,
    undo: null // { channels, sampleRate, pyramid }
  };

  var view = null;
  var rafPending = false;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheElements();
    view = new WaveformView(els.canvas);
    view._onSelectionChange = updateSelectionInfo;
    view._onCursorChange = function (t) {
      els.infoCursor.textContent = WaveformView.formatTime(t);
    };
    view._onSeek = function (t) {
      if (engine.isPlaying) return;
      engine._startOffset = t;
    };

    bindToolbar();
    bindDnd();
    bindKeyboard();

    if (dsp.mode === 'main-thread') {
      toast('warn', '性能提示',
        '当前环境无法创建 Web Worker（' + (dsp._fallbackError || '未知原因') +
        '），已降级到主线程计算，大文件可能出现短暂卡顿。建议通过 HTTP 服务访问本页面。');
    }

    setButtonsEnabled(false);
    startPlayheadLoop();
  }

  function cacheElements() {
    var ids = ['btnOpen', 'btnPlay', 'btnStop', 'btnCrop', 'btnDelete',
      'btnFadeIn', 'btnFadeOut', 'btnUndo', 'btnExport', 'fileInput',
      'waveCanvas', 'infoDuration', 'infoSampleRate', 'infoChannels',
      'infoSelection', 'infoCursor', 'emptyHint', 'loading', 'loadingText',
      'dropOverlay', 'toastHost'];
    ids.forEach(function (id) { els[id] = document.getElementById(id); });
    els.canvas = els.waveCanvas;
  }

  function bindToolbar() {
    els.btnOpen.addEventListener('click', function () { els.fileInput.click(); });
    els.fileInput.addEventListener('change', function () {
      var file = els.fileInput.files && els.fileInput.files[0];
      if (file) loadFile(file);
      els.fileInput.value = '';
    });

    els.btnPlay.addEventListener('click', togglePlay);
    els.btnStop.addEventListener('click', function () {
      engine.stop();
      view.setPlayhead(0);
      setPlayLabel(true);
    });

    els.btnCrop.addEventListener('click', function () {
      withSelection('请先框选需要保留的区域', function (sel) {
        runEdit('crop', Math.round(sel.start * state.sampleRate),
          Math.round(sel.end * state.sampleRate), '裁剪完成');
      });
    });
    els.btnDelete.addEventListener('click', function () {
      withSelection('请先框选需要删除的区域', function (sel) {
        runEdit('delete', Math.round(sel.start * state.sampleRate),
          Math.round(sel.end * state.sampleRate), '选区已删除');
      });
    });
    els.btnFadeIn.addEventListener('click', function () {
      withSelectionOrDefault('in', function (start, end) {
        runEdit('fadeIn', start, end, '已应用淡入');
      });
    });
    els.btnFadeOut.addEventListener('click', function () {
      withSelectionOrDefault('out', function (start, end) {
        runEdit('fadeOut', start, end, '已应用淡出');
      });
    });

    els.btnUndo.addEventListener('click', undo);
    els.btnExport.addEventListener('click', exportWav);
  }

  function bindDnd() {
    var overlay = els.dropOverlay;
    var dragDepth = 0;
    window.addEventListener('dragenter', function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      dragDepth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragover', function (ev) {
      if (hasFiles(ev)) ev.preventDefault();
    });
    window.addEventListener('dragleave', function (ev) {
      if (!hasFiles(ev)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) overlay.hidden = true;
    });
    window.addEventListener('drop', function (ev) {
      ev.preventDefault();
      dragDepth = 0;
      overlay.hidden = true;
      var file = ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file) loadFile(file);
    });
  }

  function hasFiles(ev) {
    return ev.dataTransfer && Array.prototype.indexOf.call(
      ev.dataTransfer.types || [], 'Files') !== -1;
  }

  function bindKeyboard() {
    window.addEventListener('keydown', function (ev) {
      var tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (ev.code === 'Space') {
        ev.preventDefault();
        togglePlay();
      } else if (ev.key === 'o' || ev.key === 'O') {
        els.fileInput.click();
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        undo();
      } else if (ev.key === 'Home') {
        ev.preventDefault();
        engine.stop();
        view.setPlayhead(0);
        setPlayLabel(true);
      }
    });
  }

  /* ---------------- 文件载入 ---------------- */

  function loadFile(file) {
    if (state.busy) return;
    if (!file.type && !/\.(wav|mp3|m4a|aac|ogg|flac|webm)$/i.test(file.name)) {
      toast('warn', '文件类型可疑',
        '已尝试打开「' + file.name + '」，若无法解码请换用常见音频格式。');
    }
    if (file.size === 0) {
      toast('error', '无法打开文件', '文件为空：' + file.name);
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      toast('warn', '大文件',
        '文件超过 500MB，解码与波形计算可能需要较长时间。');
    }

    showLoading('正在读取文件…');
    var reader = new FileReader();
    reader.onerror = function () {
      hideLoading();
      toast('error', '读取失败', '无法读取文件：' + (reader.error
        ? reader.error.message || reader.error.name : '未知错误'));
    };
    reader.onload = function () {
      decodeAndAnalyze(reader.result, file.name);
    };
    reader.readAsArrayBuffer(file);
  }

  function decodeAndAnalyze(arrayBuffer, name) {
    showLoading('正在解码音频…');
    engine.decode(arrayBuffer).then(function (audioBuffer) {
      var channels = [];
      for (var c = 0; c < audioBuffer.numberOfChannels; c++) {
        channels.push(audioBuffer.getChannelData(c));
      }
      state.channels = channels;
      state.sampleRate = audioBuffer.sampleRate;
      state.duration = audioBuffer.duration;
      state.undo = null;
      engine.setBuffer(audioBuffer);
      return rebuildPyramid('正在生成波形…');
    }).then(function () {
      applyNewAudio();
      hideLoading();
      toast('success', '载入成功',
        name + '（' + WaveformView.formatTime(state.duration) + '，' +
        state.sampleRate + ' Hz，' + state.channels.length + ' 声道）');
    }).catch(function (err) {
      hideLoading();
      toast('error', '载入失败', err && err.message ? err.message : String(err));
    });
  }

  function rebuildPyramid(loadingText) {
    showLoading(loadingText || '正在计算波形…');
    return dsp.buildPyramid(state.channels, SAMPLES_PER_BLOCK).then(function (res) {
      state.pyramid = {
        levels: res.levels,
        blockSize: res.blockSize,
        factor: res.factor,
        frames: res.frames
      };
    });
  }

  function applyNewAudio() {
    view.setSampleRateHint(state.sampleRate);
    view.setData({
      numChannels: state.channels.length,
      duration: state.duration,
      pyramid: state.pyramid
    });
    els.emptyHint.style.display = 'none';
    updateInfoBar();
    setButtonsEnabled(true);
    els.btnUndo.disabled = !state.undo;
    setPlayLabel(true);
  }

  /* ---------------- 编辑 ---------------- */

  function withSelection(emptyMsg, fn) {
    var sel = view.selection;
    if (!sel || sel.end - sel.start <= 0) {
      toast('warn', '需要选区', emptyMsg);
      return;
    }
    fn(sel);
  }

  function withSelectionOrDefault(mode, fn) {
    var sel = view.selection;
    if (sel && sel.end - sel.start > 0) {
      fn(Math.round(sel.start * state.sampleRate),
         Math.round(sel.end * state.sampleRate));
      return;
    }
    // 没有选区：对开头/结尾 1 秒做淡变
    var frames = state.channels[0].length;
    var oneSec = state.sampleRate;
    if (frames <= 1) {
      toast('warn', '无法淡变', '音频太短。');
      return;
    }
    if (mode === 'in') {
      fn(0, Math.min(oneSec, frames));
      toast('warn', '未检测到选区', '已自动对开头 1 秒应用淡入。');
    } else {
      fn(Math.max(0, frames - oneSec), frames);
      toast('warn', '未检测到选区', '已自动对结尾 1 秒应用淡出。');
    }
  }

  function runEdit(action, startFrame, endFrame, successMsg) {
    if (state.busy || !state.channels) return;

    startFrame = Math.max(0, Math.min(startFrame, state.channels[0].length));
    endFrame = Math.max(startFrame, Math.min(endFrame, state.channels[0].length));
    if (action === 'fadeIn' || action === 'fadeOut') {
      if (endFrame - startFrame < 2) {
        toast('warn', '区间太短', '淡变区间至少需要 2 个采样。');
        return;
      }
    }

    // 保存撤销快照（深拷贝；金字塔较小也一起保留）
    var snapshot = {
      channels: state.channels.map(function (ch) { return ch.slice(); }),
      sampleRate: state.sampleRate,
      pyramid: clonePyramid(state.pyramid),
      duration: state.duration
    };

    state.busy = true;
    setButtonsEnabled(false);
    showLoading('正在处理编辑…');
    engine.pause();

    dsp.edit(action, state.channels, startFrame, endFrame).then(function (res) {
      state.channels = res.channels;
      state.undo = snapshot;
      var newFrames = state.channels[0].length;
      state.duration = newFrames / state.sampleRate;

      var buffer = engine.createBuffer(state.channels, state.sampleRate);
      engine.setBuffer(buffer);

      return rebuildPyramid('正在刷新波形…');
    }).then(function () {
      applyNewAudio();
      hideLoading();
      state.busy = false;
      toast('success', '编辑成功', successMsg);
    }).catch(function (err) {
      hideLoading();
      state.busy = false;
      setButtonsEnabled(true);
      els.btnUndo.disabled = !state.undo;
      toast('error', '编辑失败', err && err.message ? err.message : String(err));
    });
  }

  function undo() {
    if (state.busy) return;
    if (!state.undo) {
      toast('warn', '无可撤销', '没有可撤销的编辑操作。');
      return;
    }
    var snap = state.undo;
    state.busy = true;
    setButtonsEnabled(false);
    showLoading('正在撤销…');
    engine.pause();

    state.channels = snap.channels;
    state.sampleRate = snap.sampleRate;
    state.pyramid = snap.pyramid;
    state.duration = snap.duration;
    state.undo = null;

    var buffer;
    try {
      buffer = engine.createBuffer(state.channels, state.sampleRate);
      engine.setBuffer(buffer);
    } catch (err) {
      state.busy = false;
      setButtonsEnabled(true);
      hideLoading();
      toast('error', '撤销失败', err.message || String(err));
      return;
    }

    applyNewAudio();
    hideLoading();
    state.busy = false;
    toast('success', '已撤销', '恢复到上一次编辑前的状态。');
  }

  function clonePyramid(p) {
    return {
      blockSize: p.blockSize,
      factor: p.factor,
      frames: p.frames,
      levels: p.levels.map(function (perCh) {
        return perCh.map(function (seg) {
          return { min: seg.min.slice(), max: seg.max.slice() };
        });
      })
    };
  }

  /* ---------------- 导出 ---------------- */

  function exportWav() {
    if (state.busy || !state.channels) return;
    var frames = state.channels[0].length;
    if (frames === 0) {
      toast('warn', '无法导出', '当前音频为空。');
      return;
    }

    state.busy = true;
    setButtonsEnabled(false);
    showLoading('正在编码 WAV…');

    dsp.exportWav(state.channels, state.sampleRate).then(function (res) {
      var blob = new Blob([res.wav], { type: 'audio/wav' });
      var url = URL.createObjectURL(blob);
      triggerDownload(url, defaultExportName());
      // 延迟释放，确保下载已启动
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      hideLoading();
      state.busy = false;
      setButtonsEnabled(true);
      els.btnUndo.disabled = !state.undo;
      var kb = Math.round(blob.size / 1024);
      toast('success', '导出成功',
        '16-bit PCM WAV，' + state.channels.length + ' 声道，' +
        state.sampleRate + ' Hz，约 ' + (kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'));
    }).catch(function (err) {
      hideLoading();
      state.busy = false;
      setButtonsEnabled(true);
      els.btnUndo.disabled = !state.undo;
      toast('error', '导出失败', err && err.message ? err.message : String(err));
    });
  }

  function defaultExportName() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'audio-edit-' + d.getFullYear() + pad(d.getMonth() + 1) +
      pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) +
      pad(d.getSeconds()) + '.wav';
  }

  function triggerDownload(url, filename) {
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
    }, 0);
  }

  /* ---------------- 播放 ---------------- */

  function togglePlay() {
    if (!state.channels || state.busy) return;
    if (engine.isPlaying) {
      var pos = engine.pause();
      view.setPlayhead(pos);
      setPlayLabel(true);
      return;
    }
    var sel = view.selection;
    var from = engine.getPosition();
    var stopAt = null;
    if (sel && sel.end - sel.start > 0) {
      // 光标在选区内则播放选区；否则从选区起点播放
      if (from < sel.start - 0.002 || from >= sel.end - 0.002) {
        from = sel.start;
      }
      stopAt = sel.end;
    } else if (from >= state.duration - 0.01) {
      from = 0;
    }
    engine.play(from, stopAt, function (endPos, reachedEnd) {
      view.setPlayhead(endPos);
      setPlayLabel(true);
      // 无选区且整首播完：回到开头，方便再次播放
      if (reachedEnd && !view.selection) {
        engine._startOffset = 0;
        view.setPlayhead(0);
      }
    });
    view.setPlayhead(from);
    setPlayLabel(false);
  }

  function setPlayLabel(stopped) {
    els.btnPlay.textContent = stopped ? '▶ 播放' : '⏸ 暂停';
  }

  function startPlayheadLoop() {
    function tick() {
      if (!document.hidden && engine.isPlaying && view.duration) {
        var pos = engine.getPosition();
        view.setPlayhead(pos);
        els.infoCursor.textContent = WaveformView.formatTime(pos);
        // 播放头越过右边缘约 70% 位置时滚动视口
        var span = view.viewEnd - view.viewStart;
        if (pos >= view.viewStart + span * 0.7) {
          view.scrollToTime(pos);
        }
      }
      rafPending = requestAnimationFrame(tick);
    }
    rafPending = requestAnimationFrame(tick);
  }

  /* ---------------- UI 辅助 ---------------- */

  function setButtonsEnabled(enabled) {
    ['btnPlay', 'btnStop', 'btnCrop', 'btnDelete', 'btnFadeIn',
     'btnFadeOut', 'btnExport'].forEach(function (id) {
      els[id].disabled = !enabled;
    });
    els.btnOpen.disabled = state.busy;
    if (enabled) els.btnUndo.disabled = !state.undo;
  }

  function showLoading(text) {
    els.loadingText.textContent = text || '处理中…';
    els.loading.hidden = false;
  }
  function hideLoading() {
    els.loading.hidden = true;
  }

  function updateInfoBar() {
    els.infoDuration.textContent = WaveformView.formatTime(state.duration);
    els.infoSampleRate.textContent = state.sampleRate + ' Hz';
    els.infoChannels.textContent = state.channels.length +
      (state.channels.length > 1 ? '（立体声）' : '（单声道）');
    updateSelectionInfo(view.selection);
    els.infoCursor.textContent = WaveformView.formatTime(view.cursorTime || 0);
  }

  function updateSelectionInfo(sel) {
    if (!els.infoSelection) return;
    if (!sel) {
      els.infoSelection.textContent = '—';
    } else {
      els.infoSelection.textContent =
        WaveformView.formatTime(sel.start) + ' → ' +
        WaveformView.formatTime(sel.end) + '（' +
        WaveformView.formatTime(sel.end - sel.start) + '）';
    }
  }

  var toastTimers = [];
  function toast(kind, title, message) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    var t = document.createElement('div');
    t.className = 'toast-title';
    t.textContent = title || '';
    var m = document.createElement('div');
    m.className = 'toast-message';
    m.textContent = message || '';
    el.appendChild(t);
    if (message) el.appendChild(m);
    els.toastHost.appendChild(el);

    var lifetime = kind === 'error' ? 8000 : 4500;
    var timer = setTimeout(function () {
      el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, lifetime);
    toastTimers.push(timer);
  }
})();

import { clamp, fadeGain } from './audio-utils.js';
import { createDemoFile } from './demo-audio.js';
import { formatTime, WaveformView } from './waveform-view.js';
import { WorkerClient, requestPeaks, requestExport } from './worker-client.js';

const $ = (selector) => document.querySelector(selector);

const elements = {
  loadDemoButton: $('#loadDemoButton'),
  openFileButton: $('#openFileButton'),
  fileInput: $('#fileInput'),
  dropZone: $('#dropZone'),
  waveCanvas: $('#waveCanvas'),
  overlayCanvas: $('#overlayCanvas'),
  emptyState: $('#emptyState'),
  playButton: $('#playButton'),
  stopButton: $('#stopButton'),
  resetButton: $('#resetButton'),
  exportButton: $('#exportButton'),
  fileReadout: $('#fileReadout'),
  timeReadout: $('#timeReadout'),
  selectionReadout: $('#selectionReadout'),
  startInput: $('#startInput'),
  endInput: $('#endInput'),
  fadeInInput: $('#fadeInInput'),
  fadeOutInput: $('#fadeOutInput'),
  startValue: $('#startValue'),
  endValue: $('#endValue'),
  fadeInValue: $('#fadeInValue'),
  fadeOutValue: $('#fadeOutValue'),
  statusText: $('#statusText'),
  progressBar: $('#progressBar'),
  toastHost: $('#toastHost')
};

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
if (!AudioContextClass) {
  showError('当前浏览器不支持 Web Audio API，无法载入和播放音频。');
}

const workerClient = new WorkerClient(new URL('./waveform.worker.js', import.meta.url));
let audioContext = null;
let view = null;
let source = null;
let busy = false;
let rafHandle = 0;
let playback = null;

function ensureAudioContext() {
  if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio API');
  if (!audioContext) audioContext = new AudioContextClass();
  return audioContext;
}

function showToast(message, kind = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  elements.toastHost.appendChild(toast);
  window.setTimeout(() => toast.remove(), 5200);
}

function showError(message) {
  setStatus(message);
  showToast(message, 'error');
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function setBusy(value, message = '处理中…') {
  busy = value;
  if (value) setStatus(message);
  updateControls();
}

function showProgress(progress) {
  elements.progressBar.hidden = progress === null;
  if (progress !== null) {
    elements.progressBar.value = clamp(progress, 0, 1);
    setStatus(`导出中 ${Math.round(clamp(progress, 0, 1) * 100)}%`);
  }
}

function currentFrames() {
  if (!source) {
    return {
      durationFrames: 0,
      durationSeconds: 0,
      startFrame: 0,
      endFrame: 0,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      playheadFrame: 0
    };
  }
  return {
    durationFrames: source.frameCount,
    durationSeconds: frameToSeconds(source.frameCount),
    startFrame: source.startFrame,
    endFrame: source.endFrame,
    fadeInFrames: source.fadeInFrames,
    fadeOutFrames: source.fadeOutFrames,
    playheadFrame: source.playheadFrame
  };
}

function syncSourceFromView() {
  if (!source) return;
  source.startFrame = view.state.startFrame;
  source.endFrame = view.state.endFrame;
  source.fadeInFrames = view.state.fadeInFrames;
  source.fadeOutFrames = view.state.fadeOutFrames;
  source.playheadFrame = view.state.playheadFrame;
}

function maximumFadeFrames() {
  if (!source) return 0;
  return Math.floor((source.endFrame - source.startFrame) / 2);
}

function secondsToFrame(seconds) {
  if (!source) return 0;
  return clamp(
    Math.round(Number(seconds) * source.sampleRate),
    0,
    source.frameCount
  );
}

function frameToSeconds(frame) {
  if (!source || !source.sampleRate) return 0;
  return frame / source.sampleRate;
}

function updateReadouts() {
  if (!source) {
    elements.fileReadout.textContent = '未载入音频';
    elements.timeReadout.textContent = '00:00.000 / 00:00.000';
    elements.selectionReadout.textContent = '选区 00:00.000';
    return;
  }
  elements.fileReadout.textContent = `${source.name} · ${source.sampleRate} Hz · ${source.channels.length} 声道`;
  elements.timeReadout.textContent = `${formatTime(frameToSeconds(source.playheadFrame))} / ${formatTime(frameToSeconds(source.frameCount))}`;
  elements.selectionReadout.textContent = `选区 ${formatTime(frameToSeconds(source.endFrame - source.startFrame))}`;
}

function configureRange(input, value, enabled) {
  input.disabled = !enabled || busy;
  input.value = String(value);
}

function updateControls() {
  const hasAudio = Boolean(source);
  elements.playButton.disabled = !hasAudio || busy;
  elements.stopButton.disabled = !hasAudio || busy;
  elements.resetButton.disabled = !hasAudio || busy;
  elements.exportButton.disabled = !hasAudio || busy;
  elements.playButton.textContent = playback ? '暂停' : '播放';

  if (!source) {
    for (const input of [
      elements.startInput,
      elements.endInput,
      elements.fadeInInput,
      elements.fadeOutInput
    ]) {
      input.disabled = true;
    }
    return;
  }

  const duration = frameToSeconds(source.frameCount);
  elements.startInput.max = duration;
  elements.endInput.max = duration;
  const maximumFade = frameToSeconds(maximumFadeFrames());
  elements.fadeInInput.max = maximumFade;
  elements.fadeOutInput.max = maximumFade;
  elements.fadeInInput.value = String(Math.min(Number(elements.fadeInInput.value) || 0, maximumFade));
  elements.fadeOutInput.value = String(Math.min(Number(elements.fadeOutInput.value) || 0, maximumFade));
  configureRange(elements.startInput, frameToSeconds(source.startFrame), true);
  configureRange(elements.endInput, frameToSeconds(source.endFrame), true);
  configureRange(elements.fadeInInput, frameToSeconds(source.fadeInFrames), true);
  configureRange(elements.fadeOutInput, frameToSeconds(source.fadeOutFrames), true);
  elements.startValue.textContent = `${frameToSeconds(source.startFrame).toFixed(3)}s`;
  elements.endValue.textContent = `${frameToSeconds(source.endFrame).toFixed(3)}s`;
  elements.fadeInValue.textContent = `${frameToSeconds(source.fadeInFrames).toFixed(3)}s`;
  elements.fadeOutValue.textContent = `${frameToSeconds(source.fadeOutFrames).toFixed(3)}s`;
  updateReadouts();
}

function applyState(patch, redraw = true) {
  view.setState(patch, { redraw });
  syncSourceFromView();
  updateControls();
}

async function decodeFile(file) {
  const context = ensureAudioContext();
  const arrayBuffer = await file.arrayBuffer();
  try {
    return await context.decodeAudioData(arrayBuffer.slice(0));
  } catch (error) {
    if (context.decodeAudioData.length < 2) throw error;
    return await new Promise((resolve, reject) => {
      context.decodeAudioData(
        arrayBuffer,
        (buffer) => resolve(buffer),
        (decodeError) => reject(decodeError || error)
      );
    });
  }
}

function channelsFromBuffer(buffer) {
  return Array.from(
    { length: buffer.numberOfChannels },
    (_, index) => buffer.getChannelData(index)
  );
}

function restoreBuffer(channels, sampleRate) {
  const context = ensureAudioContext();
  const buffer = context.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((channel, index) => {
    buffer.copyToChannel(channel, index);
  });
  return buffer;
}

async function loadFile(file) {
  if (!file) return;
  if (busy) {
    showToast('请等待当前处理完成后再载入新文件。', 'warning');
    return;
  }

  stopPlayback(true);
  setBusy(true, '正在解码音频…');
  showProgress(null);

  let decoded = null;
  let channels = null;
  let sampleRate = 0;

  try {
    if (file.size > 500 * 1024 * 1024) {
      throw new Error('文件超过 500 MB，可能导致浏览器内存不足，请选择更小的音频。');
    }
    decoded = await decodeFile(file);
    channels = channelsFromBuffer(decoded);
    sampleRate = decoded.sampleRate;
    if (!channels.length || !decoded.length) throw new Error('解码后的音频没有有效数据。');
    try {
      await workerClient.waitReady();
    } catch (_) {
    }
    const bins = Math.min(
      16000,
      Math.max(1, Math.min(1200, view.getCssWidth())),
      decoded.length
    );
    setStatus('正在计算波形峰值…');
    const result = await requestPeaks(workerClient, channels, sampleRate, bins);
    channels = result.channels;
    sampleRate = result.sampleRate || sampleRate;

    source = {
      name: file.name.replace(/\.[^.]+$/, '') || '未命名音频',
      file,
      channels,
      sampleRate,
      frameCount: channels[0].length,
      peaks: result.peaks,
      startFrame: 0,
      endFrame: channels[0].length,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      playheadFrame: 0
    };

    elements.emptyState.hidden = true;
    applyState({
      hasAudio: true,
      durationFrames: source.frameCount,
      durationSeconds: frameToSeconds(source.frameCount),
      peaks: source.peaks,
      startFrame: 0,
      endFrame: source.frameCount,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      playheadFrame: 0
    });
    setBusy(false);
    showProgress(null);
    setStatus(`已载入 ${file.name}${result.workerUsed ? '' : '（Worker 不可用，已使用主线程计算）'}`);
    showToast('音频载入成功。', 'success');
  } catch (error) {
    setBusy(false);
    showProgress(null);
    showError(`无法载入音频：${error.message || error}`);
  } finally {
    updateControls();
  }
}

function stopPlayback(resetPlayhead = false) {
  if (playback) {
    const activePlayback = playback;
    playback = null;
    activePlayback.intentional = true;
    try {
      activePlayback.source.stop();
    } catch (_) {
    }
    try {
      activePlayback.gain.disconnect();
    } catch (_) {
    }
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
  if (resetPlayhead && source) source.playheadFrame = source.startFrame;
}

function applyEnvelope(gainNode, when, outputStartFrame, outputEndFrame, fadeInFrames, fadeOutFrames, sampleRate) {
  gainNode.gain.cancelScheduledValues(when);
  const selectionFrames = outputEndFrame - outputStartFrame;
  const initialGain = clamp(fadeGain(outputStartFrame, selectionFrames, fadeInFrames, fadeOutFrames), 0, 1);

  if (fadeOutFrames > 0) {
    const fadeStartFrame = outputEndFrame - fadeOutFrames;
    const fadeRelativeStart = Math.max(0, fadeStartFrame - outputStartFrame);
    const fadeWhen = when + fadeRelativeStart / sampleRate;
    if (fadeWhen > when) gainNode.gain.setValueAtTime(initialGain, when);
    gainNode.gain.setValueAtTime(fadeWhen > when ? 1 : initialGain, fadeWhen);
    gainNode.gain.linearRampToValueAtTime(0, when + (outputEndFrame - outputStartFrame) / sampleRate);
  } else {
    gainNode.gain.setValueAtTime(initialGain, when);
  }

  if (fadeInFrames > 0 && outputStartFrame < fadeInFrames) {
    const fadeWhen = when + (fadeInFrames - outputStartFrame) / sampleRate;
    if (fadeWhen > when) {
      gainNode.gain.setValueAtTime(initialGain, when);
      gainNode.gain.linearRampToValueAtTime(1, fadeWhen);
    }
  }
}

function makePlaybackBuffer() {
  const context = ensureAudioContext();
  const buffer = restoreBuffer(source.channels, source.sampleRate);
  return buffer;
}

async function playFrom(offsetFrame = null) {
  if (!source || busy) return;
  stopPlayback(false);

  const context = ensureAudioContext();
  await context.resume();
  if (offsetFrame !== null) source.playheadFrame = clamp(offsetFrame, source.startFrame, source.endFrame);
  if (source.playheadFrame < source.startFrame || source.playheadFrame >= source.endFrame) {
    source.playheadFrame = source.startFrame;
  }

  const selectionOffset = source.startFrame;
  const outputStartFrame = source.playheadFrame - selectionOffset;
  const outputEndFrame = source.endFrame - selectionOffset;
  const duration = (outputEndFrame - outputStartFrame) / source.sampleRate;
  if (duration <= 0) {
    showToast('选区为空，请调整裁剪范围。', 'warning');
    return;
  }

  const buffer = makePlaybackBuffer();
  const bufferSource = context.createBufferSource();
  const gainNode = context.createGain();
  bufferSource.buffer = buffer;
  bufferSource.connect(gainNode);
  gainNode.connect(context.destination);

  const when = context.currentTime + 0.02;
  applyEnvelope(
    gainNode,
    when,
    outputStartFrame,
    outputEndFrame,
    source.fadeInFrames,
    source.fadeOutFrames,
    source.sampleRate
  );
  bufferSource.start(when, source.playheadFrame / source.sampleRate, duration);

  playback = {
    source: bufferSource,
    gain: gainNode,
    startedAt: when,
    startFrame: source.playheadFrame,
    endFrame: source.endFrame,
    selectionStartFrame: source.startFrame,
    intentional: false
  };

  bufferSource.onended = () => {
    if (!playback || playback.source !== bufferSource) return;
    const finished = !playback.intentional;
    playback = null;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    source.playheadFrame = finished ? source.endFrame : source.playheadFrame;
    applyState({ playheadFrame: source.playheadFrame });
  };

  const tick = () => {
    if (!playback) return;
    const contextTime = Math.max(when, context.currentTime);
    const frame = clamp(
      playback.startFrame + Math.floor((contextTime - playback.startedAt) * source.sampleRate),
      playback.selectionStartFrame,
      source.endFrame
    );
    source.playheadFrame = frame;
    view.setPlayhead(frame);
    updateReadouts();
    rafHandle = requestAnimationFrame(tick);
  };
  tick();
  updateControls();
}

function togglePlayback() {
  if (playback) {
    stopPlayback(false);
    updateControls();
    return;
  }
  playFrom(null);
}

function resetEdit() {
  if (!source || busy) return;
  stopPlayback(true);
  applyState({
    startFrame: 0,
    endFrame: source.frameCount,
    durationSeconds: frameToSeconds(source.frameCount),
    fadeInFrames: 0,
    fadeOutFrames: 0,
    playheadFrame: 0
  });
  setStatus('已重置裁剪和淡入淡出。');
}

function applyEditPatch(patch) {
  if (!source || busy) return;
  const current = currentFrames();
  const next = { ...current, ...patch };
  const duration = next.durationFrames;
  next.startFrame = clamp(next.startFrame, 0, duration - 1);
  next.endFrame = clamp(next.endFrame, next.startFrame + 1, duration);
  const maximumFade = Math.floor((next.endFrame - next.startFrame) / 2);
  next.fadeInFrames = clamp(next.fadeInFrames, 0, maximumFade);
  next.fadeOutFrames = clamp(next.fadeOutFrames, 0, maximumFade);
  if (next.fadeInFrames + next.fadeOutFrames > next.endFrame - next.startFrame) {
    next.fadeOutFrames = next.endFrame - next.startFrame - next.fadeInFrames;
  }
  next.playheadFrame = clamp(next.playheadFrame, next.startFrame, next.endFrame);
  applyState(next);
}

async function exportSelection() {
  if (!source || busy) return;
  if (playback) stopPlayback(false);
  setBusy(true, '准备导出…');
  showProgress(0);

  let channels = source.channels;
  try {
    const frameCount = source.endFrame - source.startFrame;
    if (frameCount <= 0) throw new Error('裁剪区间为空。');
    const result = await requestExport(
      workerClient,
      channels,
      {
        regionStartFrame: source.startFrame,
        frameCount,
        sampleRate: source.sampleRate,
        fadeInFrames: source.fadeInFrames,
        fadeOutFrames: source.fadeOutFrames
      },
      (progress) => showProgress(progress)
    );
    channels = result.channels;
    source.channels = channels;

    const blob = new Blob([result.wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${source.name}-edited.wav`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    setStatus('导出完成。');
    showToast(`已导出 ${link.download}${result.workerUsed ? '' : '（使用主线程导出）'}`, 'success');
  } catch (error) {
    showError(`导出失败：${error.message || error}`);
  } finally {
    showProgress(null);
    setBusy(false);
    updateControls();
  }
}

function bindRangeControls() {
  elements.startInput.addEventListener('input', () => {
    applyEditPatch({ startFrame: secondsToFrame(elements.startInput.value) });
  });
  elements.endInput.addEventListener('input', () => {
    applyEditPatch({ endFrame: secondsToFrame(elements.endInput.value) });
  });
  elements.fadeInInput.addEventListener('input', () => {
    applyEditPatch({ fadeInFrames: secondsToFrame(elements.fadeInInput.value) });
  });
  elements.fadeOutInput.addEventListener('input', () => {
    applyEditPatch({ fadeOutFrames: secondsToFrame(elements.fadeOutInput.value) });
  });
}

async function maybeRecalculatePeaks() {
  if (!source || busy || playback) return;
  await workerClient.waitReady();
  const targetBins = view.getCssWidth();
  const existing = source.peaks ? source.peaks.bins : 0;
  const shouldExpand = targetBins > existing && targetBins > existing * 1.1;
  if (!shouldExpand) return;

  setBusy(true, '正在重新计算波形精度…');
  try {
    const result = await requestPeaks(
      workerClient,
      source.channels,
      source.sampleRate,
      Math.min(16000, targetBins),
      false
    );
    source.channels = result.channels;
    source.peaks = result.peaks;
    applyState({ peaks: source.peaks });
    setStatus('波形精度已更新。');
  } catch (error) {
    showError(`波形更新失败：${error.message || error}`);
  } finally {
    setBusy(false);
    updateControls();
  }
}

function bindEvents() {
  elements.openFileButton.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', async () => {
    await loadFile(elements.fileInput.files[0]);
    elements.fileInput.value = '';
  });
  elements.loadDemoButton.addEventListener('click', () => loadFile(createDemoFile()));
  elements.playButton.addEventListener('click', togglePlayback);
  elements.stopButton.addEventListener('click', () => {
    stopPlayback(true);
    applyState({ playheadFrame: source ? source.startFrame : 0 });
  });
  elements.resetButton.addEventListener('click', resetEdit);
  elements.exportButton.addEventListener('click', exportSelection);
  bindRangeControls();

  elements.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('dragging');
  });
  elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.classList.remove('dragging');
  });
  elements.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('dragging');
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) {
      showToast('未检测到可导入的文件。', 'warning');
      return;
    }
    loadFile(file);
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    view.resize();
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(maybeRecalculatePeaks, 250);
  });

  window.addEventListener('unhandledrejection', (event) => {
    showError(`发生未处理异常：${event.reason && event.reason.message ? event.reason.message : event.reason}`);
  });
}

function initialize() {
  try {
    view = new WaveformView(elements.waveCanvas, elements.overlayCanvas, {
      onEditStart: () => {
        if (playback) stopPlayback(false);
      },
      onEdit: applyEditPatch,
      onEditEnd: () => setStatus('编辑已更新。'),
      onSeekPlay: (frame) => {
        if (frame >= source.startFrame && frame < source.endFrame) playFrom(frame);
      }
    });
    view.resize();
    bindEvents();
    updateControls();
    try {
      workerClient.start();
      setStatus('准备就绪，可拖入音频文件。');
    } catch (error) {
      showToast(`Worker 初始化失败，已自动使用主线程：${error.message}`, 'warning');
      setStatus('准备就绪（主线程模式）。');
    }
  } catch (error) {
    showError(`初始化失败：${error.message}`);
  }
}

initialize();

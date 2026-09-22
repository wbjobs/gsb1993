/*
 * 极简浏览器环境桩：加载 waveform.js / engine.js / app.js 的初始化路径，
 * 并驱动「载入 -> 导出 -> 异常提示」全流程（Web Audio 用 WAV 解码桩替代）。
 * 运行：node test/app.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DSP = require(path.join(__dirname, '..', 'js', 'dsp.js'));

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) {
    console.error('  ✗ ' + name);
    console.error('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
    process.exitCode = 1;
  }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 环境桩 ---------------- */

function noopCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 40 });
      if (k === 'setTransform' || k === 'fillRect' || k === 'clearRect' ||
          k === 'drawImage' || k === 'beginPath' || k === 'moveTo' ||
          k === 'lineTo' || k === 'stroke' || k === 'fill' || k === 'fillText' ||
          k === 'strokeRect' || k === 'closePath' || k === 'save' || k === 'restore' ||
          k === 'scale' || k === 'translate') return function () {};
      return (typeof k === 'string' && !(k in t)) ? '' : t[k];
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

class FakeElement {
  constructor(tag, id) {
    this.tagName = (tag || 'div').toUpperCase();
    this.id = id || '';
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.parentNode = null;
    this.files = null;
    this.value = '';
    this._listeners = {};
    this._ownText = '';
    this.className = '';
    this.download = '';
    this.href = '';
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  dispatch(type, ev) {
    (this._listeners[type] || []).forEach(fn => fn(ev || {}));
  }
  getContext() { return noopCtx(); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 500 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  click() { this.dispatch('click'); }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
  }
  get textContent() {
    return this._ownText + this.children.map(ch => ch.textContent).join('');
  }
  set textContent(v) { this._ownText = v; }
}

const IDs = ['btnOpen', 'btnPlay', 'btnStop', 'btnCrop', 'btnDelete',
  'btnFadeIn', 'btnFadeOut', 'btnUndo', 'btnExport', 'fileInput',
  'waveCanvas', 'infoDuration', 'infoSampleRate', 'infoChannels',
  'infoSelection', 'infoCursor', 'emptyHint', 'loading', 'loadingText',
  'dropOverlay', 'toastHost'];
const byId = {};
// index.html 中初始带 disabled 的按钮
const INIT_DISABLED = new Set(['btnPlay', 'btnStop', 'btnCrop', 'btnDelete',
  'btnFadeIn', 'btnFadeOut', 'btnUndo', 'btnExport']);
IDs.forEach(id => {
  const tag = id === 'waveCanvas' ? 'canvas' : (id === 'fileInput' ? 'input' : 'div');
  const el = new FakeElement(tag, id);
  if (INIT_DISABLED.has(id)) el.disabled = true;
  byId[id] = el;
});
const workspace = new FakeElement('div');
workspace.appendChild(byId.waveCanvas);

function makeAudioBuffer(channels, sampleRate) {
  return {
    numberOfChannels: channels.length, sampleRate,
    duration: channels[0].length / sampleRate, length: channels[0].length,
    _ch: channels,
    getChannelData(c) { return this._ch[c]; }
  };
}
class FakeSource {
  constructor() { this.onended = null; }
  connect() {}
  start() {}
  stop() { if (this.onended) { const cb = this.onended; this.onended = null; cb(); } }
  disconnect() {}
}
class FakeAudioContext {
  constructor() { this.sampleRate = 44100; this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createBuffer(n, frames, sr) {
    const ch = [];
    for (let i = 0; i < n; i++) ch.push(new Float32Array(frames));
    return makeAudioBuffer(ch, sr);
  }
  createBufferSource() { return new FakeSource(); }
  decodeAudioData(buf) {
    try {
      const dec = DSP.decodeWav(buf);
      return Promise.resolve(makeAudioBuffer(dec.channels, dec.sampleRate));
    } catch (e) { return Promise.reject(e); }
  }
}

const sandbox = {};
sandbox.console = console;
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.requestAnimationFrame = () => 0;
sandbox.cancelAnimationFrame = () => {};
sandbox.devicePixelRatio = 1;
sandbox.AudioContext = FakeAudioContext;
sandbox.Worker = undefined; // 强制主线程降级
sandbox.Blob = class Blob {
  constructor(parts) { this.size = parts[0].byteLength || 0; }
};
sandbox.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };
sandbox.document = {
  hidden: false,
  getElementById: id => byId[id] || null,
  createElement: tag => new FakeElement(tag),
  addEventListener(type, fn) { (this._ev = this._ev || {})[type] = fn; },
  body: new FakeElement('body')
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.addEventListener = function () {};
sandbox.ResizeObserver = undefined;
sandbox.FileReader = class {
  constructor() { this.onload = null; this.onerror = null; }
  readAsArrayBuffer(file) { setTimeout(() => { this.result = file._buf; this.onload(); }, 0); }
};

const ctx = vm.createContext(sandbox);
const jsDir = path.join(__dirname, '..', 'js');
const bundle = ['dsp.js', 'protocol.js', 'waveform.js', 'engine.js', 'app.js']
  .map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n;\n');
vm.runInContext(bundle, ctx, { filename: 'bundle.js' });

/* ---------------- 测试 ---------------- */

async function main() {
  console.log('app bootstrap:');

  await test('初始化后（未载入）编辑/导出按钮禁用', async () => {
    sandbox.document._ev.DOMContentLoaded();
    await wait(0);
    assert.strictEqual(byId.btnPlay.disabled, true);
    assert.strictEqual(byId.btnExport.disabled, true);
    assert.strictEqual(byId.btnUndo.disabled, true);
  });

  await test('Worker 不可用时给出降级警告', async () => {
    const texts = byId.toastHost.children.map(c => c.textContent);
    assert.ok(texts.some(t => /Worker/.test(t)), JSON.stringify(texts));
  });

  const sr = 44100;
  const left = new Float32Array(sr);
  const right = new Float32Array(sr);
  for (let i = 0; i < sr; i++) {
    left[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.6;
    right[i] = Math.sin(2 * Math.PI * 660 * i / sr) * 0.6;
  }
  const wavBuf = DSP.encodeWav([left, right], sr);

  await test('载入 1 秒立体声 WAV：按钮启用、信息栏正确', async () => {
    byId.fileInput.files = [{ name: 'tone.wav', size: wavBuf.byteLength, type: 'audio/wav', _buf: wavBuf }];
    byId.fileInput.dispatch('change');
    await wait(40);
    assert.strictEqual(byId.btnPlay.disabled, false);
    assert.strictEqual(byId.btnExport.disabled, false);
    assert.ok(/44100/.test(byId.infoSampleRate.textContent));
    assert.ok(/2（立体声）/.test(byId.infoChannels.textContent));
    assert.strictEqual(byId.loading.hidden, true);
  });

  await test('无选区点击裁剪 -> 警告提示且不改动启用状态', async () => {
    byId.btnCrop.dispatch('click');
    const texts = byId.toastHost.children.map(c => c.textContent);
    assert.ok(texts.some(t => /需要选区/.test(t)));
  });

  await test('导出 WAV：成功 toast 且按钮恢复可用', async () => {
    byId.btnExport.dispatch('click');
    await wait(60);
    assert.strictEqual(byId.loading.hidden, true);
    assert.ok(byId.toastHost.children.some(c => /导出成功/.test(c.textContent)));
    assert.strictEqual(byId.btnExport.disabled, false);
  });

  await test('空文件给出「文件为空」错误提示', async () => {
    byId.fileInput.files = [{ name: 'empty.wav', size: 0, type: 'audio/wav', _buf: new ArrayBuffer(0) }];
    byId.fileInput.dispatch('change');
    await wait(20);
    assert.ok(byId.toastHost.children.some(c => /文件为空/.test(c.textContent)));
  });

  await test('损坏文件给出解码失败错误提示', async () => {
    const bad = new ArrayBuffer(32);
    byId.fileInput.files = [{ name: 'bad.wav', size: 32, type: 'audio/wav', _buf: bad }];
    byId.fileInput.dispatch('change');
    await wait(40);
    assert.ok(byId.toastHost.children.some(c => /载入失败|解码失败/.test(c.textContent)));
  });

  await test('编辑链路（裁剪+淡入淡出+编码）音频值正确', async () => {
    const cropped = DSP.cropChannels([left, right], Math.floor(sr * 0.25), Math.floor(sr * 0.75));
    assert.strictEqual(cropped[0].length, Math.floor(sr * 0.5));
    const len = cropped[0].length;
    const fin = DSP.applyFade(cropped, 0, Math.floor(sr * 0.1), 'in');
    const fout = DSP.applyFade(fin, len - Math.floor(sr * 0.1), len, 'out');
    const wav = DSP.encodeWav(fout, sr);
    const dec = DSP.decodeWav(wav);
    assert.ok(Math.abs(dec.channels[0][0]) < 1e-4);
    assert.ok(Math.abs(dec.channels[0][len - 1]) < 1e-4);
    // 中间部分未受淡变影响
    const k = Math.floor(sr * 0.2);
    assert.ok(Math.abs(dec.channels[0][k] - cropped[0][k]) < 1e-4);
  });

  await test('UI 裁剪：时长缩短、成功提示、撤销恢复', async () => {
    // app.js 内的 view 未导出；通过 waveCanvas 的 pointerdown/move/up 模拟框选
    const canvas = byId.waveCanvas;
    const mk = (x) => ({
      clientX: x, clientY: 300, pointerId: 1,
      target: canvas, preventDefault() {}
    });
    const d0 = canvas._listeners.pointerdown[0];
    const mv = canvas._listeners.pointermove[0];
    const up = canvas._listeners.pointerup[0];
    d0(mk(250));
    mv(mk(750));
    up(mk(750));
    await wait(10);

    const beforeDuration = byId.infoDuration.textContent;
    byId.btnCrop.dispatch('click');
    await wait(60);
    assert.ok(byId.toastHost.children.some(c => /裁剪完成/.test(c.textContent)),
      '应有裁剪完成提示');
    assert.strictEqual(byId.btnUndo.disabled, false);
    const afterDuration = byId.infoDuration.textContent;
    assert.notStrictEqual(beforeDuration, afterDuration);

    byId.btnUndo.dispatch('click');
    await wait(10);
    assert.strictEqual(byId.infoDuration.textContent, beforeDuration);
    assert.strictEqual(byId.btnUndo.disabled, true);
  });

  console.log('\n' + passed + ' passed');
}

main().catch(err => { console.error(err); process.exit(1); });

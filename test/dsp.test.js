/*
 * Node 单元测试：dsp.js + protocol.js（编辑 / WAV 往返 / 金字塔精度）。
 * 运行：node test/dsp.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const DSP = require(path.join(__dirname, '..', 'js', 'dsp.js'));
const { handleRequest } = require(path.join(__dirname, '..', 'js', 'protocol.js'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n    ') : err));
    process.exitCode = 1;
  }
}

function approx(actual, expected, eps, msg) {
  assert.ok(Math.abs(actual - expected) <= (eps || 1e-6),
    (msg || '') + ' expected≈' + expected + ' got=' + actual);
}

function sine(freq, frames, sr, phase) {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    ch[i] = Math.sin(2 * Math.PI * freq * i / sr + (phase || 0));
  }
  return ch;
}

console.log('pyramid:');

test('金字塔基础块 min/max 正确（含不满一块的尾块）', () => {
  const ch = new Float32Array([0.5, -1, 0.2, 0.9, -0.4, 0.1]);
  const p = DSP.buildPyramid([ch], 4);
  const lvl0 = p.levels[0][0];
  assert.strictEqual(lvl0.min.length, 2);
  approx(lvl0.min[0], -1);
  approx(lvl0.max[0], 0.9);
  approx(lvl0.min[1], -0.4);
  approx(lvl0.max[1], 0.1);
});

test('金字塔高层聚合不丢峰', () => {
  const frames = DSP.PYRAMID_FACTOR * 4;
  const ch = new Float32Array(frames);
  ch[3] = 0.8;
  ch[frames - 2] = -0.9;
  const p = DSP.buildPyramid([ch], 1);
  assert.ok(p.levels.length >= 2);
  const top = p.levels[p.levels.length - 1][0];
  // 最高层只有一个块，应包含全局极值
  approx(top.min[0], -0.9);
  approx(top.max[0], 0.8);
});

test('每声道独立峰值（左右声道差异可区分）', () => {
  const l = new Float32Array(64).fill(0.5);
  const r = new Float32Array(64).fill(-0.3);
  const p = DSP.buildPyramid([l, r], 64);
  const lvl = p.levels[0];
  approx(lvl[0].max[0], 0.5);
  approx(lvl[0].min[0], 0.5);
  approx(lvl[1].min[0], -0.3);
  approx(lvl[1].max[0], -0.3);
});

test('金字塔覆盖帧数与输入一致，块数 = ceil(frames/blockSize)', () => {
  const sr = 48000;
  const ch = sine(440, sr + 123, sr); // 1.00256s
  const p = DSP.buildPyramid([ch], 64);
  assert.strictEqual(p.frames, sr + 123);
  assert.strictEqual(p.levels[0][0].min.length, Math.ceil((sr + 123) / 64));
});

test('金字塔峰值与直接扫描结果一致（波形准确性）', () => {
  const sr = 44100;
  const ch = sine(880, sr * 2, sr);
  const blockSize = 128;
  const p = DSP.buildPyramid([ch], blockSize);
  const base = p.levels[0][0];
  for (let b = 0; b < base.min.length; b++) {
    let mn = Infinity, mx = -Infinity;
    const s = b * blockSize, e = Math.min(s + blockSize, ch.length);
    for (let i = s; i < e; i++) { if (ch[i] < mn) mn = ch[i]; if (ch[i] > mx) mx = ch[i]; }
    approx(base.min[b], mn, 1e-7, 'block ' + b);
    approx(base.max[b], mx, 1e-7, 'block ' + b);
  }
});

console.log('editing:');

test('裁剪只保留选区内容', () => {
  const ch = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const out = DSP.cropChannels([ch], 2, 5);
  assert.strictEqual(out[0].length, 3);
  assert.deepStrictEqual(Array.from(out[0]), [3, 4, 5]);
});

test('删除区间后前后正确拼接', () => {
  const ch = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const out = DSP.deleteRange([ch], 2, 5);
  assert.deepStrictEqual(Array.from(out[0]), [1, 2, 6, 7, 8, 9, 10]);
});

test('淡入：首样本增益0，末样本增益1，中间线性', () => {
  const ch = new Float32Array(5).fill(1);
  const out = DSP.applyFade([ch], 0, 5, 'in')[0];
  approx(out[0], 0);
  approx(out[1], 0.25);
  approx(out[2], 0.5);
  approx(out[3], 0.75);
  approx(out[4], 1);
});

test('淡出：首样本增益1，末样本增益0', () => {
  const ch = new Float32Array(5).fill(1);
  const out = DSP.applyFade([ch], 0, 5, 'out')[0];
  approx(out[0], 1);
  approx(out[4], 0);
});

test('淡变不影响区间外采样', () => {
  const ch = Float32Array.from([0.9, 0.9, 0.9, 0.9, 0.9]);
  const out = DSP.applyFade([ch], 1, 4, 'in')[0];
  approx(out[0], 0.9);   // 区间外不变
  approx(out[1], 0);     // 区间起点增益 0
  approx(out[2], 0.45);  // 线性中点
  approx(out[3], 0.9);   // 区间终点增益 1
  approx(out[4], 0.9);   // 区间外不变
});

test('裁剪 + 淡入 端到端：编辑后音频值正确', () => {
  const sr = 1000;
  const ch = sine(10, 1000, sr);
  const cropped = DSP.cropChannels([ch], 100, 400);
  assert.strictEqual(cropped[0].length, 300);
  const faded = DSP.applyFade(cropped, 0, 100, 'in');
  const fch = faded[0];
  // 裁剪后第 k 个样本 = 原 ch[100+k]，淡入增益 k/99
  for (const k of [0, 1, 50, 99]) {
    approx(fch[k], ch[100 + k] * (k / 99), 1e-6);
  }
  // 淡变区间之后保持原值
  approx(fch[150], ch[250], 1e-6);
});

console.log('WAV export:');

test('WAV 往返：采样率/声道/时长/样本值正确', () => {
  const sr = 22050;
  const l = sine(440, sr, sr).map(v => v * 0.5);
  const r = sine(660, sr, sr, 1.3).map(v => v * 0.7);
  const buf = DSP.encodeWav([l, r], sr);
  assert.ok(buf instanceof ArrayBuffer);
  const dec = DSP.decodeWav(buf);
  assert.strictEqual(dec.sampleRate, sr);
  assert.strictEqual(dec.channels.length, 2);
  assert.strictEqual(dec.channels[0].length, sr);
  for (let i = 0; i < 100; i++) {
    approx(dec.channels[0][i], l[i], 1 / 32767 + 1e-6);
    approx(dec.channels[1][i], r[i], 1 / 32767 + 1e-6);
  }
});

test('WAV 头部字段正确（44 字节、PCM、data 大小）', () => {
  const ch = new Float32Array(1000).fill(0.1);
  const buf = DSP.encodeWav([ch], 44100);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const str = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  assert.strictEqual(str(0), 'RIFF');
  assert.strictEqual(str(8), 'WAVE');
  assert.strictEqual(v.getUint32(4, true), 36 + 2000);
  assert.strictEqual(v.getUint16(20, true), 1);
  assert.strictEqual(v.getUint16(22, true), 1);
  assert.strictEqual(v.getUint32(24, true), 44100);
  assert.strictEqual(v.getUint32(40, true), 2000);
});

test('削波处理：超过 ±1 的样本不溢出 int16', () => {
  const ch = Float32Array.from([1.5, -1.5, 0]);
  const buf = DSP.encodeWav([ch], 8000);
  const dec = DSP.decodeWav(buf);
  approx(dec.channels[0][0], 1, 1e-6);
  approx(dec.channels[0][1], -1, 1e-6);
});

test('空数据导出抛出异常', () => {
  assert.throws(() => DSP.encodeWav([], 44100), /没有可导出/);
  assert.throws(() => DSP.encodeWav(null, 44100), /没有可导出/);
});

console.log('protocol (worker 消息路径):');

test('handleRequest buildPyramid 返回可传输结果', () => {
  const ch = sine(440, 44100, 44100);
  const res = handleRequest({ type: 'buildPyramid', channels: [ch], samplesPerBlock: 64 });
  assert.strictEqual(res.type, 'pyramid');
  assert.ok(res.levels.length >= 1);
  assert.ok(res._transfer.includes(res.levels[0][0].min.buffer));
  assert.strictEqual(res.frames, 44100);
});

test('handleRequest edit crop 后内容正确', () => {
  const ch = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5]);
  const res = handleRequest({
    type: 'edit', action: 'crop', channels: [ch], startFrame: 1, endFrame: 4
  });
  assert.strictEqual(res.type, 'edited');
  assert.strictEqual(res.channels[0].length, 3);
  approx(res.channels[0][0], 0.2);
  approx(res.channels[0][2], 0.4);
});

test('handleRequest export 产出可解码 WAV', () => {
  const ch = sine(440, 8000, 8000);
  const res = handleRequest({ type: 'export', channels: [ch], sampleRate: 8000 });
  assert.strictEqual(res.type, 'exported');
  const dec = DSP.decodeWav(res.wav);
  assert.strictEqual(dec.sampleRate, 8000);
  assert.strictEqual(dec.channels[0].length, 8000);
});

test('未知动作抛出可提示的错误', () => {
  assert.throws(() => handleRequest({ type: 'nope' }), /未知/);
  assert.throws(
    () => handleRequest({ type: 'edit', action: 'bogus', channels: [new Float32Array(1)], startFrame: 0, endFrame: 0 }),
    /未知编辑动作/
  );
});

console.log('\n' + passed + ' passed');

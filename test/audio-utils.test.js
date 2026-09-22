import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculatePeaks,
  resamplePeaks,
  resolveFadeFrames,
  fadeGain,
  pcm16FromFloat,
  writeWavHeader,
  encodeWavRegion
} from '../src/audio-utils.js';

test('calculatePeaks aggregates every sample into peak bins', () => {
  const peaks = calculatePeaks([Float32Array.from([-1, -0.2, 0.3, 0.9])], 2);

  assert.equal(peaks.bins, 2);
  assert.equal(peaks.frameCount, 4);
  assert.ok(Math.abs(peaks.mins[0] - -1) < 1e-6);
  assert.ok(Math.abs(peaks.mins[1] - 0.3) < 1e-6);
  assert.ok(Math.abs(peaks.maxs[0] - -0.2) < 1e-6);
  assert.ok(Math.abs(peaks.maxs[1] - 0.9) < 1e-6);
});

test('calculatePeaks combines multiple channels', () => {
  const peaks = calculatePeaks(
    [Float32Array.from([-0.2, 0.5]), Float32Array.from([-0.8, 0.1])],
    1
  );

  assert.ok(Math.abs(peaks.mins[0] - -0.8) < 1e-6);
  assert.ok(Math.abs(peaks.maxs[0] - 0.5) < 1e-6);
});

test('resamplePeaks expands bins without losing extrema', () => {
  const sourceMins = Float32Array.from([-0.6, -0.2]);
  const sourceMaxs = Float32Array.from([0.3, 0.8]);
  const result = resamplePeaks(sourceMins, sourceMaxs, 4);

  assert.equal(result.mins.length, 4);
  assert.equal(result.maxs.length, 4);
  assert.ok(Math.abs(Math.min(...result.mins) - -0.6) < 1e-6);
  assert.ok(Math.abs(Math.max(...result.maxs) - 0.8) < 1e-6);
});

test('fade frame counts are independently clamped to half selection', () => {
  assert.deepEqual(resolveFadeFrames(10, 12, -2), {
    fadeInFrames: 5,
    fadeOutFrames: 0
  });
  assert.deepEqual(resolveFadeFrames(11, 4, 6), {
    fadeInFrames: 4,
    fadeOutFrames: 5
  });
});

test('linear fade gain reaches zero at both boundaries', () => {
  assert.equal(fadeGain(0, 6, 3, 2), 0);
  assert.equal(fadeGain(2, 6, 3, 2), 1);
  assert.equal(fadeGain(4, 6, 3, 2), 1);
  assert.equal(fadeGain(5, 6, 3, 2), 0);
});

test('float samples convert to clipped 16-bit PCM', () => {
  assert.equal(pcm16FromFloat(1), 32767);
  assert.equal(pcm16FromFloat(-1), -32768);
  assert.equal(pcm16FromFloat(0), 0);
  assert.equal(pcm16FromFloat(0.5), 16384);
});

test('wav header describes stereo 16-bit PCM data', () => {
  const view = new DataView(new ArrayBuffer(44));
  writeWavHeader(view, 2, 48000, 100);

  const bytes = new Uint8Array(view.buffer);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 400);
});

test('encodeWavRegion crops, fades and interleaves stereo samples', async () => {
  const left = Float32Array.from([1, 1, 1, 1, 1]);
  const right = Float32Array.from([-1, -1, -1, -1, -1]);
  const buffer = await encodeWavRegion(
    [left, right],
    {
      regionStartFrame: 1,
      frameCount: 3,
      sampleRate: 8000,
      fadeInFrames: 2,
      fadeOutFrames: 0
    }
  );
  const view = new DataView(buffer);

  assert.equal(buffer.byteLength, 44 + 3 * 2 * 2);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 0);
  assert.equal(view.getInt16(48, true), 32767);
  assert.equal(view.getInt16(50, true), -32768);
  assert.equal(view.getInt16(52, true), 32767);
  assert.equal(view.getInt16(54, true), -32768);
});

test('encodeWavRegion rejects an out-of-range crop', async () => {
  await assert.rejects(
    encodeWavRegion([Float32Array.from([0, 1])], {
      regionStartFrame: 1,
      frameCount: 3,
      sampleRate: 8000
    }),
    /超出音频范围/
  );
});

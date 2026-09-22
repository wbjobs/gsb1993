/*
 * dsp.js — 纯 DSP 函数（UMD 风格，浏览器与 Node 均可加载）。
 * 不依赖任何全局状态，方便单元测试。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DSP = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PYRAMID_FACTOR = 64; // 相邻两级峰值块的聚合倍数

  function channelCount(channels) {
    return channels.length;
  }

  /**
   * 构建多级峰值金字塔。
   * level 0：每 samplesPerBlock 个采样聚合成一个 [min,max] 块；
   * level k+1：每 PYRAMID_FACTOR 个下一级块再聚合。
   * 所有块均只覆盖真实采样（末尾不足一块时仍输出真实 min/max）。
   */
  function aggregateBlocks(channels, blockCount, samplesPerBlock, frames) {
    // 返回 [{min:Float32Array, max:Float32Array}, ...]，每个声道一套
    var perCh = new Array(channels.length);
    for (var c = 0; c < channels.length; c++) {
      perCh[c] = { min: new Float32Array(blockCount), max: new Float32Array(blockCount) };
    }
    for (var b = 0; b < blockCount; b++) {
      var start = b * samplesPerBlock;
      var end = Math.min(start + samplesPerBlock, frames);
      for (var ch = 0; ch < channels.length; ch++) {
        var data = channels[ch];
        var mn = Infinity;
        var mx = -Infinity;
        for (var i = start; i < end; i++) {
          var v = data[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        if (mn === Infinity) { mn = 0; mx = 0; }
        perCh[ch].min[b] = mn;
        perCh[ch].max[b] = mx;
      }
    }
    return perCh;
  }

  /**
   * 构建多级峰值金字塔（每个声道独立一套 min/max）。
   * level 0：每 samplesPerBlock 个采样聚合成一个 [min,max] 块；
   * level k+1：每 PYRAMID_FACTOR 个下一级块再聚合。
   * 末尾不足一块时仍输出真实 min/max。
   */
  function buildPyramid(channels, samplesPerBlock) {
    if (!channels || channels.length === 0) {
      throw new Error('buildPyramid: 没有可用声道数据');
    }
    var frames = channels[0].length;
    if (!Number.isFinite(samplesPerBlock) || samplesPerBlock < 1) {
      throw new Error('buildPyramid: 非法块大小');
    }
    var blockCount = Math.ceil(frames / samplesPerBlock);

    var base = aggregateBlocks(channels, blockCount, samplesPerBlock, frames);
    var levels = [base];

    while (base[0].min.length > 1) {
      var prev = levels[levels.length - 1];
      var prevLen = prev[0].min.length;
      var len = Math.ceil(prevLen / PYRAMID_FACTOR);
      var cur = new Array(channels.length);
      for (var ch2 = 0; ch2 < channels.length; ch2++) {
        var curMin = new Float32Array(len);
        var curMax = new Float32Array(len);
        var pMin = prev[ch2].min;
        var pMax = prev[ch2].max;
        for (var p = 0; p < len; p++) {
          var cs = p * PYRAMID_FACTOR;
          var ce = Math.min(cs + PYRAMID_FACTOR, prevLen);
          var cmn = Infinity;
          var cmx = -Infinity;
          for (var q = cs; q < ce; q++) {
            if (pMin[q] < cmn) cmn = pMin[q];
            if (pMax[q] > cmx) cmx = pMax[q];
          }
          curMin[p] = cmn;
          curMax[p] = cmx;
        }
        cur[ch2] = { min: curMin, max: curMax };
      }
      levels.push(cur);
      if (len === 1) break;
    }

    return {
      levels: levels,
      blockSize: samplesPerBlock,
      factor: PYRAMID_FACTOR,
      frames: frames
    };
  }

  function copyRange(channels, startFrame, endFrame) {
    var len = endFrame - startFrame;
    if (len < 0) throw new Error('copyRange: 长度为负');
    var out = new Array(channels.length);
    for (var c = 0; c < channels.length; c++) {
      out[c] = new Float32Array(len);
      out[c].set(channels[c].subarray(startFrame, endFrame));
    }
    return out;
  }

  function concat(channelsA, channelsB) {
    if (channelsA.length !== channelsB.length) {
      throw new Error('concat: 声道数不一致');
    }
    var out = new Array(channelsA.length);
    for (var c = 0; c < channelsA.length; c++) {
      var merged = new Float32Array(channelsA[c].length + channelsB[c].length);
      merged.set(channelsA[c], 0);
      merged.set(channelsB[c], channelsA[c].length);
      out[c] = merged;
    }
    return out;
  }

  /** 裁剪：只保留 [startFrame, endFrame) */
  function cropChannels(channels, startFrame, endFrame) {
    var frames = channels[0].length;
    startFrame = Math.max(0, Math.min(startFrame, frames));
    endFrame = Math.max(startFrame, Math.min(endFrame, frames));
    return copyRange(channels, startFrame, endFrame);
  }

  /** 删除区间：保留 [0,startFrame) + [endFrame,frames) */
  function deleteRange(channels, startFrame, endFrame) {
    var frames = channels[0].length;
    startFrame = Math.max(0, Math.min(startFrame, frames));
    endFrame = Math.max(startFrame, Math.min(endFrame, frames));
    var head = copyRange(channels, 0, startFrame);
    var tail = copyRange(channels, endFrame, frames);
    return concat(head, tail);
  }

  /**
   * 线性淡变。
   * mode 'in' : 增益从 0 -> 1；mode 'out' : 增益从 1 -> 0。
   * 区间外采样保持不变；长度为 0/1 时安全返回拷贝。
   */
  function applyFade(channels, startFrame, endFrame, mode) {
    if (mode !== 'in' && mode !== 'out') {
      throw new Error("applyFade: mode 必须是 'in' 或 'out'");
    }
    var frames = channels[0].length;
    startFrame = Math.max(0, Math.min(startFrame, frames));
    endFrame = Math.max(startFrame, Math.min(endFrame, frames));

    var out = new Array(channels.length);
    for (var c = 0; c < channels.length; c++) {
      out[c] = channels[c].slice();
    }

    var span = endFrame - startFrame;
    if (span <= 1) return out;

    for (var ch = 0; ch < out.length; ch++) {
      var data = out[ch];
      for (var i = startFrame; i < endFrame; i++) {
        var t = (i - startFrame) / (span - 1);
        var gain = mode === 'in' ? t : 1 - t;
        data[i] = data[i] * gain;
      }
    }
    return out;
  }

  function clampSample(v) {
    if (v > 1) return 32767;
    if (v < -1) return -32768;
    return v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }

  /** 交错 16-bit PCM WAV 编码，返回 ArrayBuffer。 */
  function encodeWav(channels, sampleRate) {
    if (!channels || channels.length === 0) {
      throw new Error('encodeWav: 没有可导出的音频数据');
    }
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('encodeWav: 非法采样率');
    }
    var numCh = channels.length;
    var frames = channels[0].length;
    for (var c = 1; c < numCh; c++) {
      if (channels[c].length !== frames) {
        throw new Error('encodeWav: 各声道长度不一致');
      }
    }

    var bytesPerSample = 2;
    var dataSize = frames * numCh * bytesPerSample;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);
    var pos = 0;

    function writeStr(s) {
      for (var k = 0; k < s.length; k++) view.setUint8(pos++, s.charCodeAt(k));
    }
    function writeU32(v) { view.setUint32(pos, v, true); pos += 4; }
    function writeU16(v) { view.setUint16(pos, v, true); pos += 2; }

    writeStr('RIFF');
    writeU32(36 + dataSize);
    writeStr('WAVE');
    writeStr('fmt ');
    writeU32(16);
    writeU16(1); // PCM
    writeU16(numCh);
    writeU32(sampleRate);
    writeU32(sampleRate * numCh * bytesPerSample);
    writeU16(numCh * bytesPerSample);
    writeU16(bytesPerSample * 8);
    writeStr('data');
    writeU32(dataSize);

    var offset = pos / bytesPerSample;
    for (var f = 0; f < frames; f++) {
      for (var ch2 = 0; ch2 < numCh; ch2++) {
        view.setInt16((offset + f * numCh + ch2) * bytesPerSample,
          clampSample(channels[ch2][f]), true);
      }
    }
    return buffer;
  }

  /** 最小 WAV 解码（仅测试用，支持 16-bit PCM）。 */
  function decodeWav(arrayBuffer) {
    var view = new DataView(arrayBuffer);
    var u8 = new Uint8Array(arrayBuffer);
    function strAt(o, n) {
      var s = '';
      for (var k = 0; k < n; k++) s += String.fromCharCode(u8[o + k]);
      return s;
    }
    if (strAt(0, 4) !== 'RIFF' || strAt(8, 4) !== 'WAVE') {
      throw new Error('decodeWav: 不是 WAV 文件');
    }
    var p = 12;
    var fmt = null;
    var data = null;
    while (p + 8 <= arrayBuffer.byteLength) {
      var id = strAt(p, 4);
      var size = view.getUint32(p + 4, true);
      var body = p + 8;
      if (id === 'fmt ') fmt = body;
      if (id === 'data') data = { offset: body, size: size };
      p = body + size + (size % 2);
    }
    if (!fmt || !data) throw new Error('decodeWav: 缺少 fmt/data 块');
    var audioFormat = view.getUint16(fmt, true);
    if (audioFormat !== 1) throw new Error('decodeWav: 仅支持 PCM');
    var numCh = view.getUint16(fmt + 2, true);
    var sampleRate = view.getUint32(fmt + 4, true);
    var bits = view.getUint16(fmt + 14, true);
    if (bits !== 16) throw new Error('decodeWav: 仅支持 16-bit');

    var frames = Math.floor(data.size / (numCh * 2));
    var channels = new Array(numCh);
    for (var c = 0; c < numCh; c++) channels[c] = new Float32Array(frames);
    for (var f = 0; f < frames; f++) {
      for (var ch = 0; ch < numCh; ch++) {
        var int16 = view.getInt16(data.offset + (f * numCh + ch) * 2, true);
        channels[ch][f] = int16 < 0 ? int16 / 32768 : int16 / 32767;
      }
    }
    return { channels: channels, sampleRate: sampleRate };
  }

  return {
    PYRAMID_FACTOR: PYRAMID_FACTOR,
    channelCount: channelCount,
    buildPyramid: buildPyramid,
    cropChannels: cropChannels,
    deleteRange: deleteRange,
    applyFade: applyFade,
    encodeWav: encodeWav,
    decodeWav: decodeWav
  };
});

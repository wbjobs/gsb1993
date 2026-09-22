export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function calculatePeaks(channels, bins) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error('至少需要一个音频声道');
  }
  if (!Number.isInteger(bins) || bins <= 0) {
    throw new Error('波形峰值数量必须是正整数');
  }

  const frameCount = channels[0].length;
  const mins = new Float32Array(bins);
  const maxs = new Float32Array(bins);

  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin * frameCount) / bins);
    const end = Math.max(start + 1, Math.ceil(((bin + 1) * frameCount) / bins));
    let min = Infinity;
    let max = -Infinity;

    for (let channel = 0; channel < channels.length; channel += 1) {
      const samples = channels[channel];
      for (let frame = start; frame < end && frame < frameCount; frame += 1) {
        const value = samples[frame];
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }

    mins[bin] = Number.isFinite(min) ? min : 0;
    maxs[bin] = Number.isFinite(max) ? max : 0;
  }

  return { mins, maxs, bins, frameCount };
}

export function resamplePeaks(mins, maxs, targetBins) {
  if (!Number.isInteger(targetBins) || targetBins <= 0) {
    throw new Error('目标波形峰值数量必须是正整数');
  }
  if (mins.length === targetBins && maxs.length === targetBins) {
    return { mins, maxs };
  }

  const nextMins = new Float32Array(targetBins);
  const nextMaxs = new Float32Array(targetBins);

  for (let bin = 0; bin < targetBins; bin += 1) {
    const start = Math.floor((bin * mins.length) / targetBins);
    const end = Math.max(start + 1, Math.ceil(((bin + 1) * mins.length) / targetBins));
    let min = Infinity;
    let max = -Infinity;

    for (let index = start; index < end && index < mins.length; index += 1) {
      if (mins[index] < min) min = mins[index];
      if (maxs[index] > max) max = maxs[index];
    }

    nextMins[bin] = Number.isFinite(min) ? min : 0;
    nextMaxs[bin] = Number.isFinite(max) ? max : 0;
  }

  return { mins: nextMins, maxs: nextMaxs };
}

export function resolveFadeFrames(frameCount, fadeInFrames, fadeOutFrames) {
  if (!Number.isInteger(frameCount) || frameCount < 0) {
    throw new Error('音频帧数无效');
  }
  const maximumFade = Math.floor(frameCount / 2);
  return {
    fadeInFrames: clamp(Math.trunc(fadeInFrames), 0, maximumFade),
    fadeOutFrames: clamp(Math.trunc(fadeOutFrames), 0, maximumFade)
  };
}

export function fadeGain(frame, frameCount, fadeInFrames, fadeOutFrames) {
  let gain = 1;

  if (fadeInFrames > 0 && frame < fadeInFrames) {
    gain = fadeInFrames === 1 ? 0 : frame / (fadeInFrames - 1);
  }

  const fadeOutStart = frameCount - fadeOutFrames;
  if (fadeOutFrames > 0 && frame >= fadeOutStart) {
    const fadeGainValue = fadeOutFrames === 1
      ? 0
      : (frameCount - 1 - frame) / (fadeOutFrames - 1);
    gain = Math.min(gain, fadeGainValue);
  }

  return gain;
}

export function pcm16FromFloat(value) {
  const scaled = value < 0 ? value * 32768 : value * 32767;
  if (scaled >= 32767) return 32767;
  if (scaled <= -32768) return -32768;
  return scaled < 0
    ? -Math.round(-scaled)
    : Math.round(scaled);
}

export function writeWavHeader(view, channelCount, sampleRate, frameCount) {
  const blockAlign = channelCount * 2;
  const dataSize = frameCount * blockAlign;
  const riffSize = dataSize + 36;

  if (riffSize > 0xffffffff) {
    throw new Error('导出的 WAV 文件超过 4 GiB 限制');
  }

  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, riffSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
}

export function writeWavPcmChunk(
  view,
  sourceChannels,
  regionStartFrame,
  outputStartFrame,
  outputEndFrame,
  totalOutputFrames,
  fadeInFrames,
  fadeOutFrames
) {
  const channelCount = sourceChannels.length;
  let offset = 44 + outputStartFrame * channelCount * 2;

  for (let frame = outputStartFrame; frame < outputEndFrame; frame += 1) {
    const gain = fadeGain(
      frame,
      totalOutputFrames,
      fadeInFrames,
      fadeOutFrames
    );
    const sourceFrame = regionStartFrame + frame;

    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = sourceChannels[channel][sourceFrame] * gain;
      view.setInt16(offset, pcm16FromFloat(sample), true);
      offset += 2;
    }
  }

  return offset;
}

export async function encodeWavRegion(channels, options = {}, onProgress) {
  const {
    regionStartFrame = 0,
    frameCount,
    sampleRate,
    fadeInFrames = 0,
    fadeOutFrames = 0
  } = options;

  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error('至少需要一个音频声道');
  }
  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new Error('导出区间不能为空');
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error('采样率无效');
  }

  const channelCount = channels.length;
  const expectedLength = regionStartFrame + frameCount;
  if (channels.some((channel) => channel.length < expectedLength)) {
    throw new Error('裁剪区间超出音频范围');
  }

  const fades = resolveFadeFrames(frameCount, fadeInFrames, fadeOutFrames);
  const blockAlign = channelCount * 2;
  const dataSize = frameCount * blockAlign;
  if (dataSize + 36 > 0xffffffff) {
    throw new Error('导出的 WAV 文件超过 4 GiB 限制');
  }
  const buffer = new ArrayBuffer(44 + frameCount * blockAlign);
  const view = new DataView(buffer);
  writeWavHeader(view, channelCount, sampleRate, frameCount);

  const chunkFrames = 262144;
  for (let start = 0; start < frameCount; start += chunkFrames) {
    const end = Math.min(start + chunkFrames, frameCount);
    writeWavPcmChunk(
      view,
      channels,
      regionStartFrame,
      start,
      end,
      frameCount,
      fades.fadeInFrames,
      fades.fadeOutFrames
    );
    if (onProgress) {
      await onProgress(end / frameCount);
    }
  }

  return buffer;
}

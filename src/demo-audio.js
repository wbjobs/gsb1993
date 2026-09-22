export function createDemoFile() {
  const sampleRate = 44100;
  const duration = 4;
  const frameCount = sampleRate * duration;
  const channels = [
    new Float32Array(frameCount),
    new Float32Array(frameCount)
  ];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame / sampleRate;
    const envelope = Math.min(1, time * 4) * Math.min(1, (duration - time) * 4);
    const left = Math.sin(2 * Math.PI * 220 * time) * 0.28;
    const right = Math.sin(2 * Math.PI * 330 * time + 0.4) * 0.22;
    channels[0][frame] = left * envelope;
    channels[1][frame] = right * envelope;
  }

  const wav = new ArrayBuffer(44 + frameCount * 4);
  const view = new DataView(wav);
  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + frameCount * 4, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, frameCount * 4, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    view.setInt16(offset, Math.max(-32768, Math.min(32767, channels[0][frame] * 32767)), true);
    view.setInt16(offset + 2, Math.max(-32768, Math.min(32767, channels[1][frame] * 32767)), true);
    offset += 4;
  }

  return new File([wav], '演示音频.wav', { type: 'audio/wav' });
}

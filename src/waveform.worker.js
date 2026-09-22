import { calculatePeaks, encodeWavRegion } from './audio-utils.js';

function transferChannels(channels) {
  return Array.isArray(channels)
    ? channels.map((channel) => channel.buffer)
    : [];
}

self.onmessage = async (event) => {
  const message = event.data;

  try {
    if (message.type === 'ping') {
      self.postMessage({ type: 'pong', id: message.id });
      return;
    }

    if (message.type === 'peaks') {
      const peaks = calculatePeaks(message.channels, message.bins);
      self.postMessage(
        {
          type: 'peaks:complete',
          id: message.id,
          peaks,
          channels: message.channels,
          frameCount: message.channels[0].length,
          sampleRate: message.sampleRate
        },
        [
          peaks.mins.buffer,
          peaks.maxs.buffer,
          ...transferChannels(message.channels)
        ]
      );
      return;
    }

    if (message.type === 'export') {
      const wav = await encodeWavRegion(
        message.channels,
        {
          regionStartFrame: message.regionStartFrame,
          frameCount: message.frameCount,
          sampleRate: message.sampleRate,
          fadeInFrames: message.fadeInFrames,
          fadeOutFrames: message.fadeOutFrames
        },
        async (progress) => {
          self.postMessage({
            type: 'export:progress',
            id: message.id,
            progress
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      );

      self.postMessage(
        {
          type: 'export:complete',
          id: message.id,
          wav
        },
        [wav]
      );
      return;
    }
  } catch (error) {
    self.postMessage(
      {
        type: 'worker:error',
        id: message.id,
        message: error.message,
        channels: message.channels
      },
      transferChannels(message.channels)
    );
  }
};

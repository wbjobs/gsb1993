import test from 'node:test';
import assert from 'node:assert/strict';

function installWorkerSelf() {
  const worker = {
    handler: null,
    messages: [],
    set onmessage(value) {
      this.handler = value;
    },
    get onmessage() {
      return this.handler;
    },
    postMessage(message) {
      this.messages.push(message);
    },
    dispatch(message) {
      return this.handler({ data: message });
    }
  };
  globalThis.self = worker;
  return worker;
}

function waitFor(worker, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker timeout')), 1000);
    const check = () => {
      const message = worker.messages.find(predicate);
      if (message) {
        clearTimeout(timer);
        resolve(message);
        return true;
      }
      return false;
    };
    if (check()) return;
    const interval = setInterval(() => {
      if (check()) clearInterval(interval);
    }, 10);
  });
}

test('worker returns ping, peaks and exported wav messages', async () => {
  const worker = installWorkerSelf();
  await import('../src/waveform.worker.js?worker-protocol');

  worker.dispatch({ type: 'ping', id: 1 });
  const pong = await waitFor(worker, (message) => message.type === 'pong' && message.id === 1);
  assert.deepEqual(pong, { type: 'pong', id: 1 });

  const channels = [
    Float32Array.from([0, 0.5, 1, 0.5]),
    Float32Array.from([0, -0.5, -1, -0.5])
  ];
  worker.dispatch({ type: 'peaks', id: 2, channels, sampleRate: 8000, bins: 2 });
  const peaksMessage = await waitFor(worker, (message) => message.type === 'peaks:complete' && message.id === 2);
  assert.equal(peaksMessage.peaks.bins, 2);
  assert.equal(peaksMessage.channels.length, 2);
  assert.equal(peaksMessage.frameCount, 4);

  worker.dispatch({
    type: 'export',
    id: 3,
    channels,
    regionStartFrame: 1,
    frameCount: 2,
    sampleRate: 8000,
    fadeInFrames: 1,
    fadeOutFrames: 0
  });
  await waitFor(worker, (message) => message.type === 'export:progress' && message.id === 3);
  const complete = await waitFor(worker, (message) => message.type === 'export:complete' && message.id === 3);
  assert.equal(complete.wav.byteLength, 44 + 2 * 2 * 2);
});

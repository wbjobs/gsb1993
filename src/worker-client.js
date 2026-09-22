import { calculatePeaks, encodeWavRegion } from './audio-utils.js';

export class WorkerClient {
  constructor(workerUrl) {
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.readyPromise = null;
    this.enabled = typeof Worker !== 'undefined';
    this.workerUrl = workerUrl;
    this.failed = !this.enabled;
  }

  start() {
    if (!this.enabled || this.worker) return;
    try {
      this.worker = new Worker(this.workerUrl, { type: 'module' });
      this.worker.onmessage = (event) => this.handleMessage(event.data);
      this.worker.onerror = (event) => this.handleFailure(event.message || 'Web Worker 运行失败');
    } catch (error) {
      this.worker = null;
      this.failed = true;
      throw error;
    }
  }

  async waitReady(timeoutMs = 1200) {
    if (!this.enabled) return false;
    if (this.failed) return false;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (!ok) this.handleFailure('Web Worker 无响应');
        resolve(ok);
      };

      try {
        this.start();
      } catch (_) {
        finish(false);
        return;
      }

      const timer = window.setTimeout(() => finish(false), timeoutMs);
      const previousHandler = this.worker.onmessage;
      this.worker.onmessage = (event) => {
        if (event.data && event.data.type === 'pong') {
          window.clearTimeout(timer);
          this.worker.onmessage = previousHandler;
          finish(true);
          return;
        }
        if (previousHandler) previousHandler(event);
      };
      this.worker.postMessage({ type: 'ping' });
    });

    return this.readyPromise;
  }

  handleMessage(message) {
    if (message.type === 'export:progress') {
      const request = this.pending.get(message.id);
      if (request && request.onProgress) request.onProgress(message.progress);
      return;
    }

    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);

    if (message.type === 'worker:error') {
      const error = new Error(message.message || 'Web Worker 处理失败');
      error.channels = message.channels;
      request.reject(error);
      return;
    }

    if (message.type === 'peaks:complete') request.resolve(message);
    if (message.type === 'export:complete') request.resolve(message);
  }

  handleFailure(message) {
    this.readyPromise = Promise.resolve(false);
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    this.failed = true;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const request of pending) {
      request.reject(new Error(message));
    }
  }

  request(message, transfer = [], onProgress) {
    if (!this.worker || this.failed) {
      return Promise.reject(new Error('Web Worker 不可用'));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve,
        reject,
        onProgress
      });
      try {
        const payload = { ...message };
        delete payload.onProgress;
        this.worker.postMessage({ ...payload, id }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

export async function requestPeaks(client, channels, sampleRate, bins, shouldTransfer = true) {
  if (client.enabled && !client.failed) {
    try {
      const transfer = shouldTransfer ? channels.map((channel) => channel.buffer) : [];
      const response = await client.request({
        type: 'peaks',
        channels,
        sampleRate,
        bins
      }, transfer);
      return {
        peaks: response.peaks,
        channels: response.channels,
        workerUsed: true
      };
    } catch (error) {
      if (error.channels) {
        return fallbackPeaks(error.channels, sampleRate, bins);
      }
      throw error;
    }
  }
  return fallbackPeaks(channels, sampleRate, bins);
}

function fallbackPeaks(channels, sampleRate, bins) {
  const peaks = calculatePeaks(channels, bins);
  return {
    peaks,
    channels,
    sampleRate,
    workerUsed: false
  };
}

export async function requestExport(client, channels, options, onProgress) {
  if (client.enabled && !client.failed) {
    try {
      const response = await client.request({
        type: 'export',
        channels,
        ...options
      }, [], onProgress);
      return { wav: response.wav, channels, workerUsed: true };
    } catch (error) {
      if (error.channels) {
        return fallbackExport(error.channels, options, onProgress, true);
      }
      throw error;
    }
  }
  return fallbackExport(channels, options, onProgress, false);
}

async function fallbackExport(channels, options, onProgress, workerFailed) {
  const wav = await encodeWavRegion(channels, options, onProgress);
  return { wav, channels, workerUsed: false, workerFailed: Boolean(workerFailed) };
}

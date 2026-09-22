/* 模拟 Dedicated Worker 全局环境，验证 dsp-worker.js 的消息处理。 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) {
    console.error('  ✗ ' + name + '\n    ' + err.message);
    process.exitCode = 1;
  }
}

function createWorkerSandbox() {
  const sandbox = {};
  sandbox.self = sandbox;
  // 注入标准内建对象，模拟 Worker 全局环境
  // Worker 中没有 CommonJS 的 module/exports，UMD 才会走浏览器分支
  var blocked = { window:1, global:1, globalThis:1, document:1,
    importScripts:1, postMessage:1, self:1, module:1, exports:1,
    require:1, process:1, Buffer:1 };
  Object.getOwnPropertyNames(globalThis).forEach(function (name) {
    if (blocked[name]) return;
    sandbox[name] = globalThis[name];
  });
  sandbox.console = console;
  sandbox.importScripts = function (...files) {
    files.forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx));
  };
  sandbox.postMessage = function () { sandbox._posted.push(arguments); };
  sandbox._posted = [];
  const ctx = vm.createContext(sandbox);
  return { sandbox, ctx };
}

console.log('worker bootstrap:');

test('importScripts + buildPyramid 消息返回峰值数据', () => {
  const { sandbox, ctx } = createWorkerSandbox();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'dsp-worker.js'), 'utf8'), ctx);
  const ch = new Float32Array(44100);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.sin(2 * Math.PI * 440 * i / 44100);
  sandbox.postMessage = (msg, transfer) => {
    assert.strictEqual(msg.type, 'pyramid');
    assert.strictEqual(msg.id, 1);
    assert.ok(msg.levels[0][0].min.length === Math.ceil(44100 / 64));
    assert.ok(transfer.length > 0);
  };
  sandbox.onmessage({ data: { id: 1, type: 'buildPyramid', channels: [ch], samplesPerBlock: 64 } });
});

test('edit(delete) 消息返回删除后的声道', () => {
  const { sandbox, ctx } = createWorkerSandbox();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'dsp-worker.js'), 'utf8'), ctx);
  const ch = Float32Array.from([1, 2, 3, 4, 5]);
  sandbox.postMessage = (msg, transfer) => {
    assert.strictEqual(msg.type, 'edited');
    assert.deepStrictEqual(Array.from(msg.channels[0]), [1, 2, 5]);
    assert.strictEqual(transfer.length, 1);
  };
  sandbox.onmessage({ data: { id: 2, type: 'edit', action: 'delete', channels: [ch], startFrame: 2, endFrame: 4 } });
});

test('export 消息返回 WAV ArrayBuffer 且不转移声道', () => {
  const { sandbox, ctx } = createWorkerSandbox();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'dsp-worker.js'), 'utf8'), ctx);
  const ch = new Float32Array(8000);
  sandbox.postMessage = (msg, transfer) => {
    assert.strictEqual(msg.type, 'exported');
    assert.strictEqual(msg.wav.byteLength, 44 + 16000);
    // transfer 中应包含 WAV 缓冲本身（跨 vm realm，用字节数比较）
    assert.strictEqual(transfer.length, 1);
    assert.strictEqual(transfer[0].byteLength, msg.wav.byteLength);
  };
  sandbox.onmessage({ data: { id: 3, type: 'export', channels: [ch], sampleRate: 8000 } });
});

test('错误消息可被 worker 捕获并回传', () => {
  const { sandbox, ctx } = createWorkerSandbox();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'dsp-worker.js'), 'utf8'), ctx);
  sandbox.postMessage = (msg) => {
    assert.strictEqual(msg.type, 'error');
    assert.strictEqual(msg.id, 9);
    assert.ok(/没有可导出/.test(msg.message));
  };
  sandbox.onmessage({ data: { id: 9, type: 'export', channels: [], sampleRate: 44100 } });
});

/* ---- DspClient 降级重试 ---- */
const Protocol = require(path.join(__dirname, '..', 'js', 'protocol.js'));

console.log('DspClient fallback:');

const asyncTests = [];
function atest(name, fn) {
  asyncTests.push({ name, fn });
}

atest('Worker 构造失败时直接走主线程且请求成功', () => {
  const savedWorker = global.Worker;
  global.Worker = undefined;
  const client = new Protocol.DspClient();
  assert.strictEqual(client.mode, 'main-thread');
  const ch = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) ch[i] = Math.sin(i / 10);
  return client.exportWav([ch], 8000).then(res => {
    assert.strictEqual(res.type, 'exported');
    assert.strictEqual(res.wav.byteLength, 44 + 2000);
    global.Worker = savedWorker;
  });
});

atest('Worker 首次运行报错时挂起请求自动在主线程重试', () => {
  const savedWorker = global.Worker;
  function BrokenWorker() {
    const self = this;
    this.onmessage = null;
    this.onerror = null;
    setTimeout(() => self.onerror && self.onerror(new Error('404 script')), 0);
  }
  BrokenWorker.prototype.postMessage = function () {};
  BrokenWorker.prototype.terminate = function () {};
  global.Worker = BrokenWorker;

  const client = new Protocol.DspClient();
  const ch = new Float32Array(500).fill(0.25);
  return client.cropChannelsViaEdit
    ? Promise.reject(new Error('no such api'))
    : client.edit('crop', [ch], 100, 400).then(res => {
        assert.strictEqual(res.type, 'edited');
        assert.strictEqual(res.channels[0].length, 300);
        assert.strictEqual(client.mode, 'main-thread');
        global.Worker = savedWorker;
      });
});


(async function runAsync() {
  for (const t of asyncTests) {
    try {
      await t.fn();
      passed++;
      console.log('  ✓ ' + t.name);
    } catch (err) {
      console.error('  ✗ ' + t.name + '\n    ' + (err.stack || err));
      process.exitCode = 1;
    }
  }
  console.log('\n' + passed + ' passed');
})();

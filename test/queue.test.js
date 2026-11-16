'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createApp } = require('../server');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, message = 'condition', timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timeout waiting for ${message}`);
}

async function setup(t, limit = '2') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bodealer-queue-'));
  const jobsDir = path.join(root, 'jobs');
  const walrus = path.join(root, 'walrus');
  // Controlled fake solver, separate from the real executable integration tests.
  await fs.writeFile(walrus, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const result = process.argv[process.argv.indexOf('-logresult') + 1];
const dir = path.dirname(result);
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'});
console.log('child=' + child.pid);
fs.writeFileSync(result, 'partial result');
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(dir, 'release'))) return;
  clearInterval(timer);
  child.kill();
  fs.writeFileSync(result, 'complete result');
  process.exitCode = fs.existsSync(path.join(dir, 'fail')) ? 7 : 0;
}, 20);
`, { mode: 0o755 });
  const env = { NODE_ENV: 'test', BACKEND_API_TOKEN: '', WALRUS_PATH: walrus, JOBS_DIR: jobsDir, MAX_CONCURRENT_TASKS: limit };
  const apps = [];
  const servers = [];
  async function serve() {
    const app = createApp({ env });
    apps.push(app);
    await app.locals.ready;
    const server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve(instance));
      instance.once('error', reject);
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, options = {}) {
      const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(4000) });
      const body = await response.json();
      assert.ok(response.ok, JSON.stringify(body));
      return body;
    }
    async function submit() {
      const body = new FormData();
      body.append('configFile', new Blob(['TASK NAME:test\n']), 'config.txt');
      return request('/tasks', { method: 'POST', body });
    }
    return { app, request, submit };
  }
  t.after(async () => {
    for (const app of apps) await app.locals.shutdown();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, jobsDir, env, serve, release: (id) => fs.writeFile(path.join(jobsDir, id, 'release'), '') };
}

async function state(api, id, status) {
  return until(async () => {
    const body = await api.request(`/tasks/${id}`);
    return body.status === status && body;
  }, `${id}: ${status}`);
}

test('FIFO limit, partial progress, queued cancellation, and promotion on completion/failure', async (t) => {
  const setupData = await setup(t);
  const { serve, release, jobsDir } = setupData;
  const api = await serve();
  const [a, b] = await Promise.all([api.submit(), api.submit()]);
  const c = await api.submit();
  const d = await api.submit();
  assert.equal(c.status, 'queued');
  assert.equal(d.status, 'queued');
  assert.equal((await state(api, c.id, 'queued')).pid, null);
  const health = await api.request('/health');
  assert.deepEqual(health, { status: 'ok', runningTasks: 2, queuedTasks: 2, maxConcurrentTasks: 2 });
  await until(async () => (await api.request(`/tasks/${a.id}`)).resultText === 'partial result', 'live result');
  await api.request(`/tasks/${d.id}`, { method: 'DELETE' });
  await release(a.id);
  await state(api, a.id, 'completed');
  await state(api, c.id, 'running');
  // A second waiting task is promoted after a nonzero exit too.
  const e = await api.submit();
  assert.equal(e.status, 'queued');
  await fs.writeFile(path.join(jobsDir, b.id, 'fail'), '');
  await release(b.id);
  assert.equal((await state(api, b.id, 'failed')).exitCode, 7);
  await state(api, e.id, 'running');
  await Promise.all([release(c.id), release(e.id)]);
  await Promise.all([state(api, c.id, 'completed'), state(api, e.id, 'completed')]);
  const cancelled = await state(api, d.id, 'cancelled');
  assert.equal(cancelled.pid, null);
  await assert.rejects(fs.access(path.join(jobsDir, d.id, 'rescalc.txt')), { code: 'ENOENT' });
});

test('duplicate running cancellation kills the process group and promotes queued work', async (t) => {
  const { serve } = await setup(t, '1');
  const api = await serve();
  const a = await api.submit();
  const b = await api.submit();
  const running = await until(async () => {
    const value = await api.request(`/tasks/${a.id}`);
    return /child=\d+/.test(value.logTail || '') && value;
  }, 'child PID');
  const childPid = Number(running.logTail.match(/child=(\d+)/)[1]);
  await Promise.all([0, 1].map(() => api.request(`/tasks/${a.id}`, { method: 'DELETE' })));
  await state(api, b.id, 'running');
  await until(() => {
    try { process.kill(childPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }, 'child termination');
  assert.throws(() => process.kill(running.pid, 0), { code: 'ESRCH' });
  assert.equal((await api.request('/health')).runningTasks, 1);
});

test('restart preserves terminal states/results and fails running/queued without replaying PIDs', async (t) => {
  const { serve, jobsDir } = await setup(t);
  await fs.mkdir(jobsDir, { recursive: true });
  const ids = {};
  for (const status of ['completed', 'failed', 'cancelled', 'running', 'queued']) {
    const id = ids[status] = randomUUID();
    const dir = path.join(jobsDir, id);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id, status, pid: process.pid, finishedAt: status === 'completed' ? '2026-01-01T00:00:00Z' : null }));
    await fs.writeFile(path.join(dir, 'rescalc.txt'), `${status} result`);
  }
  const api = await serve();
  for (const [previous, id] of Object.entries(ids)) {
    const task = await api.request(`/tasks/${id}`);
    assert.equal(task.resultText, `${previous} result`);
    assert.equal(task.status, ['running', 'queued'].includes(previous) ? 'failed' : previous);
    if (['running', 'queued'].includes(previous)) assert.match(task.error, /restart/);
  }
  assert.equal((await api.request('/health')).runningTasks, 0);
  assert.equal((await api.request('/tasks')).length, 5);
});

test('graceful shutdown interrupts active and queued tasks and preserves partial files', async (t) => {
  const { serve, jobsDir } = await setup(t, '1');
  const api = await serve();
  const a = await api.submit();
  const b = await api.submit();
  await until(async () => (await api.request(`/tasks/${a.id}`)).resultText === 'partial result');
  await Promise.all([api.app.locals.shutdown(), api.app.locals.shutdown()]);
  const recovered = await serve();
  for (const task of [a, b]) {
    assert.match((await state(recovered, task.id, 'failed')).error, /shutdown/);
  }
  assert.equal(await fs.readFile(path.join(jobsDir, a.id, 'rescalc.txt'), 'utf8'), 'partial result');
  assert.equal((await recovered.request('/health')).runningTasks, 0);
});

test('invalid limits and corrupt persisted state fail startup clearly', async (t) => {
  for (const value of ['0', '-1', '2.5', 'invalid', '']) {
    assert.throws(() => createApp({ env: { MAX_CONCURRENT_TASKS: value } }), /positive integer/);
  }
  const { jobsDir, env } = await setup(t);
  const dir = path.join(jobsDir, randomUUID());
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), '{');
  await assert.rejects(createApp({ env }).locals.ready, /Cannot recover task state/);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} stops the standalone API and its active process group`, async (t) => {
    const { env } = await setup(t, '1');
    const server = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
      env: { ...process.env, ...env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout.on('data', (chunk) => { output += chunk; });
    server.stderr.on('data', (chunk) => { output += chunk; });
    const closed = once(server, 'close');
    t.after(async () => { if (server.exitCode === null) server.kill('SIGKILL'); await closed; });
    const port = await until(() => output.match(/listening on port (\d+)/)?.[1], 'server startup');
    const form = new FormData();
    form.append('configFile', new Blob(['TASK NAME:test\n']), 'config.txt');
    const options = { signal: AbortSignal.timeout(4000) };
    const task = await (await fetch(`http://127.0.0.1:${port}/tasks`, { ...options, method: 'POST', body: form })).json();
    const running = await until(async () => {
      const state = await (await fetch(`http://127.0.0.1:${port}/tasks/${task.id}`, { signal: AbortSignal.timeout(4000) })).json();
      return /child=\d+/.test(state.logTail || '') && state;
    });
    server.kill(signal);
    const [code] = await Promise.race([closed, sleep(6000).then(() => { throw new Error('Shutdown timeout'); })]);
    assert.equal(code, 0, output);
    assert.throws(() => process.kill(running.pid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(Number(running.logTail.match(/child=(\d+)/)[1]), 0), { code: 'ESRCH' });
  });
}

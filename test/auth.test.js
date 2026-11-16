'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createApp } = require('../server');
const { createTokenAuth } = require('../auth');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(t, authenticated = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bodealer-auth-'));
  const token = randomBytes(32).toString('hex');
  const jobsDir = path.join(root, 'jobs');
  const walrus = path.join(root, 'walrus');
  await fs.writeFile(walrus, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const result = process.argv[process.argv.indexOf('-logresult')+1];
console.log('solver credential present=' + ('BACKEND_API_TOKEN' in process.env));
fs.writeFileSync(result, 'partial calculation result');
const timer = setInterval(() => {
 if (fs.existsSync(path.join(path.dirname(result),'release'))) {
  fs.writeFileSync(result,'complete calculation result'); clearInterval(timer);
 }
}, 25);
`, { mode: 0o755 });
  const env = { WALRUS_PATH: walrus, JOBS_DIR: jobsDir, MAX_CONCURRENT_TASKS: '1',
    NODE_ENV: authenticated ? 'production' : 'development',
    ...(authenticated ? { BACKEND_API_TOKEN: token } : {}),
  };
  const app = createApp({ env });
  let server;
  t.after(async () => {
    await app.locals.shutdown();
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await app.locals.ready;
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve(instance));
    instance.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, options = {}, authorization = `Bearer ${token}`) {
    const headers = new Headers(options.headers);
    if (authorization !== null) headers.set('Authorization', authorization);
    const response = await fetch(base + route, { ...options, headers, signal: AbortSignal.timeout(4000) });
    const text = await response.text();
    assert.equal(text.includes(token), false, 'Response must not expose credentials');
    return { response, body: text ? JSON.parse(text) : null };
  }
  const form = () => {
    const body = new FormData();
    body.append('configFile', new Blob(['TASK NAME:test\n']), 'config.txt');
    return body;
  };
  async function wait(id, predicate) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const { body } = await request(`/tasks/${id}`);
      if (predicate(body)) return body;
      await sleep(25);
    }
    throw new Error('Task polling timed out');
  }
  return { root, app, token, jobsDir, request, form, wait };
}

test('missing/malformed/invalid credentials cannot submit, list, read, cancel, or reach future endpoints', async (t) => {
  const { app, request, form, jobsDir, token } = await setup(t);
  const id = randomUUID();
  const dir = path.join(jobsDir, id);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id, status: 'completed' }));
  await fs.writeFile(path.join(dir, 'rescalc.txt'), 'private existing result');
  const credentials = [null, 'Basic invalid', 'Bearer', 'Bearer wrong', `Bearer ${token.slice(1)}`,
    `Bearer ${token}extra`, `Bearer ${token}, Bearer wrong`, `Bearer  ${token}`];
  for (const auth of credentials) {
    for (const [method, route] of [['POST', '/tasks'], ['GET', '/tasks'], ['GET', `/tasks/${id}`],
      ['DELETE', `/tasks/${id}`], ['GET', `/tasks/${id}/download`], ['GET', '/management']]) {
      const { response, body } = await request(route, { method, ...(method === 'POST' ? { body: form() } : {}) }, auth);
      assert.equal(response.status, 401);
      assert.deepEqual(body, { error: 'Unauthorized' });
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    }
  }
  // Authentication must happen before body parsing and task-ID validation.
  assert.equal((await request('/tasks', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } }, null)).response.status, 401);
  assert.equal((await request('/tasks/not-a-uuid', {}, null)).response.status, 401);
  assert.equal((await request(`/tasks?token=${token}`, {}, null)).response.status, 401);
  assert.equal(app.locals.tasks.size, 0);
  assert.deepEqual(await fs.readdir(jobsDir), [id]);
  assert.equal(await fs.readFile(path.join(dir, 'rescalc.txt'), 'utf8'), 'private existing result');
});

test('health is public and operational only, even with invalid credentials', async (t) => {
  const { request } = await setup(t);
  for (const auth of [null, 'Bearer invalid']) {
    const { response, body } = await request('/health', {}, auth);
    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: 'ok', runningTasks: 0, queuedTasks: 0, maxConcurrentTasks: 1 });
  }
  assert.equal((await request('/health/tasks', {}, null)).response.status, 401);
});

test('valid token preserves submission, progress, listing, queued/running cancellation and final results', async (t) => {
  const { app, request, form, wait, jobsDir, token } = await setup(t);
  const previousToken = process.env.BACKEND_API_TOKEN;
  process.env.BACKEND_API_TOKEN = token;
  t.after(() => {
    if (previousToken === undefined) delete process.env.BACKEND_API_TOKEN;
    else process.env.BACKEND_API_TOKEN = previousToken;
  });
  const submitted = await request('/tasks', { method: 'POST', body: form() });
  assert.equal(submitted.response.status, 202);
  const id = submitted.body.id;
  await wait(id, (s) => s.status === 'running' && s.resultText && s.logTail);
  const running = (await request(`/tasks/${id}`)).body;
  assert.match(running.logTail, /solver credential present=false/);
  assert.equal((await request('/tasks', {}, `bearer ${token}`)).response.status, 200);
  for (const auth of [null, 'Bearer invalid']) {
    assert.equal((await request(`/tasks/${id}`, {}, auth)).response.status, 401);
    assert.equal((await request(`/tasks/${id}`, { method: 'DELETE' }, auth)).response.status, 401);
  }
  assert.equal((await request(`/tasks/${id}`)).body.status, 'running');
  const queued = (await request('/tasks', { method: 'POST', body: form() })).body;
  assert.equal(queued.status, 'queued');
  assert.equal((await request(`/tasks/${queued.id}`, { method: 'DELETE' })).body.status, 'cancelled');
  assert.equal(app.locals.tasks.get(queued.id).pid, null);
  assert.equal((await request(`/tasks/${id}`, { method: 'DELETE' })).body.status, 'cancelled');
  const complete = (await request('/tasks', { method: 'POST', body: form() })).body;
  await wait(complete.id, (s) => s.status === 'running' && s.resultText);
  await fs.writeFile(path.join(jobsDir, complete.id, 'release'), '');
  const result = await wait(complete.id, (s) => s.status === 'completed');
  assert.equal(result.resultText, 'complete calculation result');
  assert.equal(result.exitCode, 0);
  assert.equal((await request(`/tasks/${complete.id}`, {}, null)).response.status, 401);
  await app.locals.shutdown();
  for (const task of await fs.readdir(jobsDir)) {
    for (const file of await fs.readdir(path.join(jobsDir, task))) {
      assert.equal((await fs.readFile(path.join(jobsDir, task, file))).includes(Buffer.from(token)), false, 'Task files must not contain credentials');
    }
  }
});

test('local development without a configured token retains existing behavior', async (t) => {
  const { request } = await setup(t, false);
  assert.equal((await request('/tasks', {}, null)).response.status, 200);
});

test('production fails before creating files when the token is missing, empty or whitespace-only', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bodealer-auth-startup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const token of [undefined, '', '   ']) {
    const env = { ...process.env, NODE_ENV: 'production', JOBS_DIR: path.join(root, randomUUID()), PORT: '0' };
    delete env.BACKEND_API_TOKEN;
    if (token !== undefined) env.BACKEND_API_TOKEN = token;
    assert.throws(() => createApp({ env }), /BACKEND_API_TOKEN is required in production/);
    const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const [code] = await once(child, 'close');
    clearTimeout(timer);
    assert.equal(code, 1);
    assert.match(output, /BACKEND_API_TOKEN is required in production/);
    await assert.rejects(fs.access(env.JOBS_DIR), { code: 'ENOENT' });
  }
});

test('malformed configured tokens fail with a generic message', () => {
  const token = `${randomBytes(32).toString('hex')} invalid`;
  assert.throws(() => createTokenAuth({ BACKEND_API_TOKEN: token }), (error) =>
    error.message === 'BACKEND_API_TOKEN must be a Bearer token without whitespace' && !error.message.includes(token));
});

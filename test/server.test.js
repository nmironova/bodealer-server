'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { createApp, executableName, resolveWalrusPath } = require('../server');

async function fixture(source, name = 'walrus') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bodealer-server-'));
  const bin = path.join(root, 'bin');
  await fsp.mkdir(bin);
  const walrus = path.join(bin, name);
  await fsp.writeFile(walrus, source, { mode: 0o755 });
  return { root, walrus, jobsDir: path.join(root, 'jobs') };
}

async function serve(setup, env = { WALRUS_PATH: setup.walrus }) {
  const app = createApp({ rootDir: setup.root, jobsDir: setup.jobsDir, env });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function createTask(base, config = 'TASK NAME:test\n') {
  const form = new FormData();
  form.append('configFile', new Blob([config]), 'config.txt');
  const response = await fetch(`${base}/tasks`, { method: 'POST', body: form });
  return { response, body: await response.json() };
}

async function waitFor(base, id, statuses) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const body = await (await fetch(`${base}/tasks/${id}`)).json();
    if (statuses.includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Task ${id} did not reach ${statuses.join(', ')}`);
}

test('successful calculation captures logs and result text', async (t) => {
  const setup = await fixture(`#!/bin/sh\necho stdout-line\necho stderr-line >&2\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-logresult" ]; then shift; printf 'answer text' > "$1"; fi\n  shift\ndone\nexit 0\n`);
  const { server, base } = await serve(setup);
  t.after(() => server.close());
  const created = await createTask(base);
  assert.equal(created.response.status, 202);
  const task = await waitFor(base, created.body.id, ['completed']);
  assert.equal(task.resultText, 'answer text');
  assert.equal(task.result, 'answer text');
  assert.match(task.logTail, /stdout-line/);
  assert.match(task.logTail, /stderr-line/);
  assert.equal(task.exitCode, 0);
});

test('rejects a task when configured Walrus is missing', async (t) => {
  const setup = await fixture('#!/bin/sh\nexit 0\n');
  const { server, base } = await serve(setup, { WALRUS_PATH: path.join(setup.root, 'missing') });
  t.after(() => server.close());
  const created = await createTask(base);
  assert.equal(created.response.status, 503);
  assert.match(created.body.error, /missing or not executable/);
});

test('reports spawn startup errors', async (t) => {
  const setup = await fixture('#!/definitely/missing/interpreter\n');
  const { server, base } = await serve(setup);
  t.after(() => server.close());
  const created = await createTask(base);
  const task = await waitFor(base, created.body.id, ['failed']);
  assert.match(task.error, /ENOENT|spawn/);
});

test('reports a non-zero exit', async (t) => {
  const setup = await fixture('#!/bin/sh\necho bad >&2\nexit 7\n');
  const { server, base } = await serve(setup);
  t.after(() => server.close());
  const created = await createTask(base);
  const task = await waitFor(base, created.body.id, ['failed']);
  assert.equal(task.exitCode, 7);
  assert.match(task.error, /code 7/);
  assert.match(task.logTail, /bad/);
});

test('cancels a running task and its child process', async (t) => {
  const setup = await fixture('#!/bin/sh\nsleep 30 &\nchild=$!\necho "$child"\nwait "$child"\n');
  const { server, base } = await serve(setup);
  t.after(() => server.close());
  const created = await createTask(base);
  const running = await waitFor(base, created.body.id, ['running']);
  const childPid = Number(String(running.logTail || '').trim());
  const response = await fetch(`${base}/tasks/${created.body.id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'cancelled');
  const cancelled = await waitFor(base, created.body.id, ['cancelled']);
  assert.equal(cancelled.status, 'cancelled');
  if (childPid) assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});

test('selects platform-specific executable names and configuration precedence', () => {
  assert.equal(executableName('win32'), 'Walrus.exe');
  assert.equal(executableName('linux'), 'walrus');
  assert.equal(executableName('darwin'), 'walrus');
  assert.equal(resolveWalrusPath({ env: { BODEALER_BIN_DIR: '/build/bin' }, platform: 'win32', rootDir: '/server' }), path.resolve('/build/bin/Walrus.exe'));
  assert.equal(resolveWalrusPath({ env: { WALRUS_PATH: '/custom/walrus', BODEALER_BIN_DIR: '/ignored' }, platform: 'linux', rootDir: '/server' }), path.resolve('/custom/walrus'));
  assert.equal(resolveWalrusPath({ env: {}, platform: 'darwin', rootDir: '/server' }), path.resolve('/server/exes/darwin/walrus'));
  assert.equal(resolveWalrusPath({ env: {}, platform: 'linux', rootDir: '/server' }), path.resolve('/server/exes/linux/walrus'));
  assert.equal(resolveWalrusPath({ env: {}, platform: 'win32', rootDir: '/server' }), path.resolve('/server/exes/win32/Walrus.exe'));
});

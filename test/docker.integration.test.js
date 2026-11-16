'use strict';

// Host-side real solver/container lifecycle test. Never targets the Compose
// production volume: every run owns a uniquely named container, image and volume.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (value) => createHash('sha256').update(value).digest('hex');

test('Linux Docker: real concurrency, queue, progress, cancellation, volume and restart recovery', {
  skip: process.env.BODEALER_DOCKER_TEST !== '1', timeout: 1200000,
}, async () => {
  const token = randomBytes(32).toString('hex');
  const suffix = randomUUID();
  const name = `bodealer-test-${suffix}`;
  const volume = `${name}-jobs`;
  const image = `${name}:local`;
  const config = await fs.readFile(path.join(__dirname, 'fixtures/concurrent-start.txt'));
  const report = { tasks: [], checks: [] };
  const docker = async (...args) => (await exec('docker', args, {
    env: { ...process.env, BACKEND_API_TOKEN: token },
    cwd: path.join(__dirname, '..'), timeout: 600000, maxBuffer: 8 * 1024 * 1024,
  })).stdout.trim();
  let base;
  let createdVolume = false;
  let createdContainer = false;
  async function api(route, options = {}) {
    const headers = new Headers(options.headers);
    if (route !== '/health') headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(base + route, { ...options, headers, signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    assert.ok(response.ok, `${route}: ${JSON.stringify(body)}`);
    return body;
  }
  async function wait(fn, label, ms = 240000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const result = await fn();
      if (result) return result;
      await sleep(200);
    }
    throw new Error(`Timeout: ${label}`);
  }
  async function healthy() {
    const port = (await docker('port', name, '3001/tcp')).match(/:(\d+)\s*$/)?.[1];
    assert.ok(port, 'Missing mapped API port');
    base = `http://127.0.0.1:${port}`;
    await wait(async () => { try { return (await api('/health')).status === 'ok'; } catch { return false; } }, 'health', 30000);
  }
  async function submit() {
    const body = new FormData();
    body.append('configFile', new Blob([config]), 'config.txt');
    return api('/tasks', { method: 'POST', body });
  }
  const get = (id) => api(`/tasks/${id}`);
  const cancel = (id) => api(`/tasks/${id}`, { method: 'DELETE' });
  async function processList() {
    return (await docker('exec', name, 'ps', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'comm='))
      .split('\n').map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        return m && { pid: Number(m[1]), ppid: Number(m[2]), status: m[3], command: m[4] };
      }).filter(Boolean);
  }
  async function oscars(id) {
    const task = await get(id);
    return (await processList()).filter((p) => p.ppid === task.pid && /oscar/i.test(p.command));
  }
  async function fileInfo(id) {
    return JSON.parse(await docker('exec', name, 'node', '-e', `
      const fs=require('fs'),crypto=require('crypto');
      const dir='/app/jobs/'+process.argv[1], out={};
      for(const file of ['start_from.txt','rescalc.txt','logs.txt','state.json']) {
        const bytes=fs.readFileSync(dir+'/'+file), stat=fs.statSync(dir+'/'+file);
        out[file]={bytes:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex'),inode:stat.ino};
      }
      console.log(JSON.stringify(out));`, id));
  }
  try {
    await docker('info');
    // Deliberately fail here if real Linux binaries or dependencies are absent.
    await docker('build', '-t', image, '.');
    // Reuse the existing real pair/isolation/nondeterminism test inside Linux.
    console.log(await docker('run', '--rm', image, 'npm', 'run', 'test:concurrency'));
    report.checks.push('existing real concurrency test passed inside Linux');
    await docker('volume', 'create', volume);
    createdVolume = true;
    await docker('run', '-d', '--name', name, '-p', '127.0.0.1::3001',
      '-e', 'BACKEND_API_TOKEN', '-e', 'MAX_CONCURRENT_TASKS=2', '-v', `${volume}:/app/jobs`, image);
    createdContainer = true;
    await healthy();
    const denied = await fetch(base + '/tasks', { method: 'POST', signal: AbortSignal.timeout(10000) });
    assert.equal(denied.status, 401);
    assert.equal((await api('/health')).runningTasks, 0);
    assert.deepEqual(await api('/tasks'), []);
    const [a, b] = await Promise.all([submit(), submit()]);
    const c = await submit();
    const d = await submit();
    assert.equal(c.status, 'queued');
    assert.equal(d.status, 'queued');
    assert.equal((await get(c.id)).pid, null);
    const health = await api('/health');
    assert.equal(health.runningTasks, 2);
    assert.equal(health.queuedTasks, 2);
    await cancel(d.id);
    assert.equal((await get(d.id)).pid, null);
    const partial = await wait(async () => {
      const states = await Promise.all([get(a.id), get(b.id)]);
      return states.find((s) => s.status === 'running' && s.resultText?.length > 0 && s.logTail?.length > 0);
    }, 'partial Oscar results and logs');
    report.checks.push(`live partial result observed for ${partial.id}`);
    const children = await wait(async () => {
      const pairs = await Promise.all([oscars(a.id), oscars(b.id)]);
      return pairs.every((p) => p.length) && pairs;
    }, 'two real Oscar children');
    report.oscarPids = children.map((pair) => pair.map((p) => p.pid));
    const startedThird = await wait(async () => {
      const third = await get(c.id);
      return third.startedAt && third;
    }, 'third task promotion after completion');
    const initial = await Promise.all([get(a.id), get(b.id)]);
    assert.ok(initial.some((s) => s.status === 'completed' && Date.parse(s.finishedAt) <= Date.parse(startedThird.startedAt)));
    const completed = await Promise.all([a, b, c].map((task) => wait(async () => {
      const state = await get(task.id);
      assert.ok(!['failed', 'cancelled'].includes(state.status), JSON.stringify(state));
      return state.status === 'completed' && state;
    }, `${task.id} completion`)));
    await wait(async () => (await api('/health')).runningTasks === 0, 'persisted completion');
    const files = await Promise.all(completed.map((task) => fileInfo(task.id)));
    assert.equal(new Set(files.map((f) => f['rescalc.txt'].inode)).size, 3);
    for (const [i, task] of completed.entries()) {
      assert.equal(task.exitCode, 0);
      // Native worker batches can overshoot SCALE 20 by different amounts.
      const processed = task.resultText.match(/Processed: (\d+) total\./);
      const down = task.resultText.match(/\(down\):[^\n]*,\s*(\d+)\s*\r?\n/);
      const make = task.resultText.match(/\(make\):[^\n]*,\s*(\d+)\s*\r?\n/);
      assert.ok(processed && Number(processed[1]) >= 20000, 'Incomplete board sample');
      assert.ok(down && make && Number(down[1]) + Number(make[1]) === Number(processed[1]), 'Inconsistent board totals');
      assert.match(task.resultText, /Chance to make = [\d.]+%/);
      assert.equal(files[i]['start_from.txt'].hash, sha(config));
      report.tasks.push({ id: task.id, pid: task.pid, startedAt: task.startedAt, finishedAt: task.finishedAt,
        exitCode: task.exitCode, durationMs: Date.parse(task.finishedAt) - Date.parse(task.startedAt), files: files[i] });
    }
    report.overlapMs = Math.min(...completed.slice(0, 2).map((s) => Date.parse(s.finishedAt))) - Math.max(...completed.slice(0, 2).map((s) => Date.parse(s.startedAt)));
    assert.ok(report.overlapMs > 0);
    assert.equal((await get(d.id)).status, 'cancelled');
    report.checks.push('third task queued/promoted; fourth cancelled without execution; all three results isolated');

    // Cancel a live pair and verify both the Walrus and observed Oscar disappear.
    const cancelled = await submit();
    const beforeCancel = await wait(async () => {
      const task = await get(cancelled.id);
      const children = await oscars(task.id);
      return children.length && { task, children };
    }, 'Oscar before cancellation');
    await cancel(cancelled.id);
    await wait(async () => {
      const live = await processList();
      const ids = [beforeCancel.task.pid, ...beforeCancel.children.map((p) => p.pid)];
      return !live.some((p) => ids.includes(p.pid));
    }, 'Walrus/Oscar cancellation', 10000);
    report.checks.push('running cancellation removed Walrus and Oscar');

    // Normal shutdown, recreation with the same volume, and preserved results.
    const inFlight = await Promise.all([submit(), submit()]);
    const queued = await submit();
    assert.equal(queued.status, 'queued');
    await wait(async () => (await oscars(inFlight[0].id)).length > 0, 'active Oscar before shutdown');
    await docker('stop', '-t', '25', name);
    assert.equal(await docker('inspect', '-f', '{{.State.ExitCode}}', name), '0');
    await docker('rm', name);
    createdContainer = false;
    await docker('run', '-d', '--name', name, '-p', '127.0.0.1::3001',
      '-e', 'BACKEND_API_TOKEN', '-e', 'MAX_CONCURRENT_TASKS=2', '-v', `${volume}:/app/jobs`, image);
    createdContainer = true;
    await healthy();
    for (const task of [...inFlight, queued]) {
      const state = await get(task.id);
      assert.equal(state.status, 'failed');
      assert.match(state.error, /shutdown/);
    }
    assert.deepEqual(await fileInfo(a.id), files[0]);
    assert.equal((await get(a.id)).status, 'completed');
    assert.equal((await get(d.id)).status, 'cancelled');
    assert.equal((await get(cancelled.id)).status, 'cancelled');
    report.checks.push('graceful shutdown and container recreation preserved files and terminal states');

    // Abrupt container death leaves disk states running/queued for recovery.
    const abrupt = await Promise.all([submit(), submit()]);
    const abruptQueued = await submit();
    assert.equal(abruptQueued.status, 'queued');
    await wait(async () => (await oscars(abrupt[0].id)).length > 0, 'active Oscar before hard stop');
    await docker('kill', '-s', 'KILL', name);
    await docker('start', name);
    await healthy();
    for (const task of [...abrupt, abruptQueued]) {
      const state = await get(task.id);
      assert.equal(state.status, 'failed');
      assert.match(state.error, /restart/);
    }
    assert.equal((await api('/health')).runningTasks, 0);
    assert.equal((await processList()).filter((p) => /^(walrus|oscar)$/.test(p.command)).length, 0);
    assert.deepEqual(await fileInfo(a.id), files[0]);
    report.checks.push('hard-stop recovery failed interrupted running/queued tasks without replay');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (createdContainer) console.error(await docker('logs', name).catch(String));
    throw error;
  } finally {
    const errors = [];
    if (createdContainer) await docker('rm', '-f', name).catch((error) => errors.push(error));
    if (createdVolume) await docker('volume', 'rm', volume).catch((error) => errors.push(error));
    await docker('image', 'rm', image).catch(() => {});
    if (errors.length) throw new AggregateError(errors, 'Failed to clean test-owned Docker resources');
  }
});

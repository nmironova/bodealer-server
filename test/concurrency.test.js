'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createApp, resolveWalrusPath, validateWalrus } = require('../server');
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Only remove the explicitly identified performance footer, never scores or boards.
function normalize(text) {
  return text.replace(/\r\n/g, '\n').split('\n')
    .filter((line) => !/^The search took .*-->.*boards per minute\.$/.test(line))
    .map((line) => line.trimEnd()).join('\n').trim();
}

test('real Walrus/Oscar calculations run concurrently with independent files', {
  skip: process.env.BODEALER_CONCURRENCY_TEST !== '1',
}, async (t) => {
  assert.notEqual(process.platform, 'win32', 'Process observation currently requires POSIX ps');
  const timeoutMs = Number(process.env.CONCURRENCY_TIMEOUT_MS || 180000);
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'Invalid timeout');
  const source = resolveWalrusPath();
  await validateWalrus(source);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bodealer-concurrency-'));
  const keepArtifacts = process.env.KEEP_TEST_ARTIFACTS === '1';
  t.after(async () => {
    if (!keepArtifacts) await fs.rm(root, { recursive: true, force: true });
  });
  const runtime = path.join(root, 'runtime');
  const jobsDir = path.join(root, 'jobs');
  await fs.mkdir(runtime);
  // Keep the production shared-cwd behavior, but protect the original runtime.
  for (const name of await fs.readdir(path.dirname(source))) {
    await fs.cp(path.join(path.dirname(source), name), path.join(runtime, name), { recursive: true });
  }
  async function snapshot(dir, prefix = '') {
    const result = {};
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) Object.assign(result, await snapshot(path.join(dir, entry.name), relative));
      else {
        const stat = await fs.stat(path.join(dir, entry.name));
        result[relative] = { hash: hash(await fs.readFile(path.join(dir, entry.name))), mtimeMs: stat.mtimeMs };
      }
    }
    return result;
  }
  const before = await snapshot(runtime);
  const config = await fs.readFile(path.join(__dirname, 'fixtures/concurrent-start.txt'));
  const token = randomBytes(32).toString('hex');
  const app = createApp({ jobsDir, env: { NODE_ENV: 'production', BACKEND_API_TOKEN: token, WALRUS_PATH: path.join(runtime, path.basename(source)) } });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve(instance));
    instance.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = { root, artifactsRetained: keepArtifacts, source, configSha256: hash(config), tasks: [], processSamples: [], failures: [] };
  const check = (condition, message) => { if (!condition) report.failures.push(message); };
  async function request(url, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(base + url, { ...options, headers, signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
    return { response, body };
  }
  try {
    // Both requests are in flight before either is awaited.
    const submissions = await Promise.all([0, 1].map(async () => {
      const form = new FormData();
      form.append('configFile', new Blob([config]), 'start_from.txt');
      const submittedAt = new Date().toISOString();
      const { response, body } = await request('/tasks', { method: 'POST', body: form });
      assert.equal(response.status, 202);
      return { id: body.id, submittedAt };
    }));
    report.tasks = submissions;
    check(submissions[0].id !== submissions[1].id, 'Task IDs collide');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const states = await Promise.all(submissions.map(({ id }) => request(`/tasks/${id}`).then((r) => r.body)));
      states.forEach((state, i) => Object.assign(report.tasks[i], state, {
        resultText: undefined, result: undefined, logTail: undefined,
        durationMs: state.finishedAt ? Date.parse(state.finishedAt) - Date.parse(state.startedAt) : null,
      }));
      const { stdout } = await exec('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm=']);
      const processes = stdout.trim().split('\n').map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return match && { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
      }).filter(Boolean);
      const pids = states.map((s) => s.pid);
      report.processSamples.push({ at: new Date().toISOString(), processes: processes.filter((p) => pids.includes(p.pid) || pids.includes(p.ppid)) });
      if (states.every((s) => ['completed', 'failed', 'cancelled'].includes(s.status))) break;
      await sleep(200);
    }
    for (const task of report.tasks) {
      check(task.status === 'completed', `${task.id}: ${task.status}, ${task.error || 'timeout'}`);
      check(task.exitCode === 0, `${task.id}: unexpected exit ${task.exitCode}`);
    }
    // Observe final persisted state/logs after the supervisor's async close handler.
    await sleep(250);
    const results = [];
    const identities = [];
    for (const task of report.tasks) {
      const dir = path.join(jobsDir, task.id);
      task.files = {};
      for (const name of ['start_from.txt', 'rescalc.txt', 'logs.txt', 'state.json']) {
        try {
          const filename = path.join(dir, name);
          const [bytes, stat] = await Promise.all([fs.readFile(filename), fs.stat(filename)]);
          task.files[name] = { path: filename, bytes: stat.size, sha256: hash(bytes), device: stat.dev, inode: stat.ino };
          if (name === 'start_from.txt') check(bytes.equals(config), `${task.id}: configuration changed`);
          if (name === 'rescalc.txt') {
            results.push(bytes.toString('utf8'));
            identities.push(`${stat.dev}:${stat.ino}`);
          }
          if (name === 'state.json') {
            const state = JSON.parse(bytes);
            task.signal = state.signal;
            check(state.id === task.id && state.status === task.status && state.exitCode === 0 && !state.signal, `${task.id}: invalid persisted state or termination signal`);
            check(state.args[1] === path.join(dir, 'start_from.txt') && state.args[3] === path.join(dir, 'rescalc.txt'), `${task.id}: shared config/result arguments`);
          }
        } catch (error) { check(false, `${task.id}/${name}: ${error.message}`); }
      }
    }
    check(identities.length === 2 && identities[0] !== identities[1], 'Results are missing or share an inode');
    check(report.tasks[0].pid !== report.tasks[1].pid, 'Walrus PIDs collide');
    for (const [i, result] of results.entries()) {
      check(result.includes('Fixed hand is [N:AK7.6.AT874.AKJ7]') && result.includes('Scorer to use is V6N BY N'), `Result ${i}: wrong task identity`);
      const processed = result.match(/Processed: (\d+) total\./);
      const down = result.match(/\(down\):[^\n]*,\s*(\d+)\s*\r?\n/);
      const make = result.match(/\(make\):[^\n]*,\s*(\d+)\s*\r?\n/);
      check(processed && Number(processed[1]) >= 20000 && down && make && Number(down[1]) + Number(make[1]) === Number(processed[1]), `Result ${i}: incomplete or inconsistent board totals`);
      check(/Averages:.*Chance to make = [\d.]+%/.test(result) && /The search took /.test(result), `Result ${i}: missing final summary`);
    }
    if (results.length === 2) {
      report.comparison = {
        byteIdentical: results[0] === results[1],
        identicalWithoutPerformanceFooter: normalize(results[0]) === normalize(results[1]),
        stableTaskHeaderIdentical: results[0].split('----')[0] === results[1].split('----')[0],
        note: 'Only the timing/throughput footer is normalized. Random deals, examples and score statistics may vary; numerical differences are reported, not silently removed or treated as proof of interference.',
      };
      check(report.comparison.stableTaskHeaderIdentical, 'Task/scorer/filter headers differ');
    }
    report.overlapMs = Math.max(0, Math.min(...report.tasks.map((t) => Date.parse(t.finishedAt))) - Math.max(...report.tasks.map((t) => Date.parse(t.startedAt))));
    report.simultaneousWalrusObserved = report.processSamples.some((s) => report.tasks.every((t) => s.processes.some((p) => p.pid === t.pid)));
    report.oscarPids = report.tasks.map((t) => [...new Set(report.processSamples.flatMap((s) => s.processes.filter((p) => p.ppid === t.pid && /oscar/i.test(p.command)).map((p) => p.pid)))]);
    check(report.overlapMs > 0 && report.simultaneousWalrusObserved, 'Concurrent Walrus execution not demonstrated');
    check(report.oscarPids.every((pids) => pids.length > 0), 'Oscar children not observed for both tasks');
    const after = await snapshot(runtime);
    report.sharedRuntimeChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]));
    check(report.sharedRuntimeChanges.length === 0, `Shared runtime files changed: ${report.sharedRuntimeChanges.join(', ')}`);
  } catch (error) {
    report.failures.push(error.stack || String(error));
  } finally {
    // Cancel only this test's unfinished processes; DELETE preserves their files.
    for (const task of app.locals.tasks.values()) {
      if (task.child && task.child.exitCode === null) {
        try { await request(`/tasks/${task.id}`, { method: 'DELETE' }); }
        catch (error) { report.failures.push(`Cleanup: ${error.message}`); }
      }
    }
    try { await app.locals.shutdown(); }
    catch (error) { report.failures.push(`Shutdown: ${error.message}`); }
    await new Promise((resolve) => server.close(resolve));
    report.passed = report.failures.length === 0;
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, processSamples: `${report.processSamples.length} samples; set KEEP_TEST_ARTIFACTS=1 to retain report.json` }, null, 2));
  }
  assert.deepEqual(report.failures, [], `See ${root}/report.json`);
});

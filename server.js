'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { randomUUID } = require('crypto');
const multer = require('multer');
const { createTokenAuth } = require('./auth');

const execFileAsync = promisify(execFile);
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });
const CONFIG_FILE = 'start_from.txt';
const LOG_FILE = 'logs.txt';
const RESULT_FILE = 'rescalc.txt';
const STATE_FILE = 'state.json';
const MAX_LOG_TAIL_BYTES = 64 * 1024;
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function executableName(platform = process.platform) {
  return platform === 'win32' ? 'Walrus.exe' : 'walrus';
}

function resolveWalrusPath({ env = process.env, platform = process.platform, rootDir = __dirname } = {}) {
  if (env.WALRUS_PATH) return path.resolve(env.WALRUS_PATH);
  const binDir = env.BODEALER_BIN_DIR
    ? path.resolve(env.BODEALER_BIN_DIR)
    : path.join(rootDir, 'exes', platform);
  return path.join(binDir, executableName(platform));
}

async function validateWalrus(walrusPath, platform = process.platform) {
  const mode = platform === 'win32' ? fs.constants.F_OK : fs.constants.F_OK | fs.constants.X_OK;
  try {
    const stat = await fsp.stat(walrusPath);
    if (!stat.isFile()) throw new Error('not a file');
    await fsp.access(walrusPath, mode);
  } catch (error) {
    throw new Error(`Walrus is missing or not executable at ${walrusPath}: ${error.message}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function selectTaskInConfig(configText, taskName) {
  if (!taskName) return configText;
  let found = false;
  const taskRe = /^\s*(\/\/\s*)?TASK NAME\s*:\s*([A-Za-z0-9_]+)\s*$/;
  const lines = configText.split(/\r?\n/).map((line) => {
    const match = line.match(taskRe);
    if (!match) return line;
    if (match[2] === taskName) {
      found = true;
      return `TASK NAME:${match[2]}`;
    }
    return `//TASK NAME:${match[2]}`;
  });
  if (!found) throw new Error(`TASK NAME:${taskName} not found in config`);
  return `${lines.join('\r\n')}\r\n`;
}

async function readTail(filePath, maxBytes) {
  if (!(await exists(filePath))) return null;
  const stat = await fsp.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readText(filePath) {
  return (await exists(filePath)) ? fsp.readFile(filePath, 'utf8') : null;
}

async function readState(jobDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(jobDir, STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

// Serialize snapshots per task and rename atomically so polling/restarts never
// observe half-written JSON or an older write overtaking a terminal state.
const stateWrites = new WeakMap();
function writeState(task) {
  const { child, dir, ...state } = task;
  const json = JSON.stringify(state, null, 2);
  const pending = (stateWrites.get(task) || Promise.resolve()).catch(() => {}).then(async () => {
    const temporary = path.join(dir, `${STATE_FILE}.tmp`);
    await fsp.writeFile(temporary, json, 'utf8');
    await fsp.rename(temporary, path.join(dir, STATE_FILE));
  });
  stateWrites.set(task, pending);
  return pending;
}

function signalIfAlive(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function terminateProcessTree(task, platform = process.platform) {
  if (!task.pid) return;
  if (platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/pid', String(task.pid), '/T', '/F'], { windowsHide: true });
    } catch (error) {
      if (task.child.exitCode === null) throw error;
    }
    return;
  }

  // Each solver starts a new process group. Oscar inherits that group, so
  // signalling it also covers children created during cancellation.
  signalIfAlive(-task.pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  signalIfAlive(-task.pid, 'SIGKILL');
}

function createApp(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const authenticate = createTokenAuth(env);
  const jobsDir = path.resolve(options.jobsDir || env.JOBS_DIR || path.join(rootDir, 'jobs'));
  const maxConcurrentTasks = Number(env.MAX_CONCURRENT_TASKS ?? 2);
  if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) {
    throw new Error('MAX_CONCURRENT_TASKS must be a positive integer');
  }
  const tasks = new Map();
  const queue = [];
  const active = new Set();
  const cancellations = new Map();
  const admissions = new Set();
  let stopping = false;
  let shutdownPromise;
  const app = express();
  // Authenticate before parsing bodies, reading task state, or accepting uploads.
  // Protect future endpoints by default; GET /health is the sole public route.
  app.use(authenticate);
  const ready = (async () => {
    await fsp.mkdir(jobsDir, { recursive: true });
    for (const id of await fsp.readdir(jobsDir)) {
      if (!TASK_ID_RE.test(id)) continue;
      const dir = path.join(jobsDir, id);
      const state = await readState(dir);
      if (!state) throw new Error(`Cannot recover task state: ${dir}`);
      const task = { ...state, id, dir, child: null };
      tasks.set(id, task);
      if (['running', 'queued'].includes(task.status)) {
        task.error = `Interrupted by server restart (previously ${task.status}); resubmit explicitly`;
        task.status = 'failed';
        task.finishedAt = nowIso();
        // Never signal a persisted PID: it can belong to an unrelated process.
        await writeState(task);
      }
    }
  })();
  // Also used by startup; attach a handler immediately for embedded callers.
  ready.catch(() => {});
  app.use(async (req, res, next) => {
    try {
      await ready;
      if (stopping && req.method !== 'GET') return res.status(503).json({ error: 'Server is shutting down' });
      next();
    } catch (error) { res.status(503).json({ error: `Startup recovery failed: ${error.message}` }); }
  });
  app.use(express.json({ limit: '1mb' }));

  async function finishTask(task, updates) {
    Object.assign(task, updates, { finishedAt: task.finishedAt || nowIso() });
    await writeState(task);
  }

  async function startJob(task, walrusPath) {
    const configPath = path.join(task.dir, CONFIG_FILE);
    const resultPath = path.join(task.dir, RESULT_FILE);
    const args = ['-cfgname', configPath, '-logresult', resultPath, '-exitondone'];
    const logStream = fs.createWriteStream(path.join(task.dir, LOG_FILE), { flags: 'a' });
    const solverEnv = { ...process.env };
    delete solverEnv.BACKEND_API_TOKEN;
    const child = spawn(walrusPath, args, {
      env: solverEnv,
      cwd: path.dirname(walrusPath),
      windowsHide: true,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    task.child = child;
    task.pid = child.pid || null;
    task.status = 'running';
    task.startedAt = nowIso();
    task.walrusPath = walrusPath;
    task.args = args;

    child.stdout.on('data', (chunk) => logStream.write(chunk));
    child.stderr.on('data', (chunk) => logStream.write(chunk));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    logStream.on('error', (error) => {
      task.error = task.error || `Log write failed: ${error.message}`;
    });

    let spawnError = null;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => {
      // Keep the slot occupied until cancellation and state/log flushing finish.
      (async () => {
        await cancellations.get(task.id);
        await new Promise((resolve) => logStream.end(resolve));
        task.exitCode = code;
        task.signal = signal;
        if (task.status === 'running') {
          Object.assign(task, code === 0 && !spawnError
            ? { status: 'completed', error: task.error || null }
            : { status: 'failed', error: spawnError?.message || `Walrus exited with code ${code}${signal ? ` (${signal})` : ''}` });
        }
        task.child = null;
        await finishTask(task, {});
      })().catch((error) => {
        task.status = 'failed';
        task.error = `Finalization failed: ${error.message}`;
        console.error(task.id, task.error);
      }).finally(() => {
        active.delete(task.id);
        cancellations.delete(task.id);
        schedule();
      });
    });
    await writeState(task);
  }

  function schedule() {
    while (!stopping && active.size < maxConcurrentTasks && queue.length) {
      const task = queue.shift();
      if (task.status !== 'queued') continue;
      active.add(task.id); // Reserve synchronously before any asynchronous work.
      startJob(task, task.walrusPath).catch(async (error) => {
        task.error = error.message;
        if (task.child) {
          await cancelTask(task, 'failed', error.message);
        } else {
          await finishTask(task, { status: 'failed', error: error.message });
          active.delete(task.id);
          schedule();
        }
      }).catch((error) => console.error('Task startup failed:', task.id, error));
    }
  }

  function cancelTask(task, status = 'cancelled', error = null) {
    if (cancellations.has(task.id)) return cancellations.get(task.id);
    if (!['queued', 'running'].includes(task.status)) return Promise.resolve();
    const wasRunning = task.status === 'running';
    Object.assign(task, { status, error, finishedAt: nowIso() });
    const pending = (async () => {
      // Termination must still happen if persisting the cancellation fails.
      try { await writeState(task); }
      finally { if (wasRunning) await terminateProcessTree(task, platform); }
    })();
    cancellations.set(task.id, pending);
    pending.finally(() => {
      if (!wasRunning) cancellations.delete(task.id);
      schedule();
    }).catch(() => {});
    return pending;
  }

  app.get('/health', (_req, res) => res.status(stopping ? 503 : 200).json({
    status: stopping ? 'stopping' : 'ok',
    runningTasks: active.size,
    queuedTasks: queue.filter((t) => t.status === 'queued').length,
    maxConcurrentTasks,
  }));

  async function submitTask(req, res) {
    try {
      if (!req.file) return res.status(400).json({ error: 'configFile is required' });
      const walrusPath = resolveWalrusPath({ env, platform, rootDir });
      await validateWalrus(walrusPath, platform);
      await fsp.mkdir(jobsDir, { recursive: true });
      const id = randomUUID();
      const jobDir = path.join(jobsDir, id);
      const encoding = String(req.body.encoding || 'utf8').toLowerCase();
      const configText = req.file.buffer.toString(encoding === 'win1251' ? 'binary' : 'utf8');
      const finalConfig = selectTaskInConfig(configText, req.body.taskName);
      await fsp.mkdir(jobDir);
      await fsp.writeFile(path.join(jobDir, CONFIG_FILE), finalConfig.endsWith('\n') ? finalConfig : `${finalConfig}\r\n`, encoding === 'win1251' ? 'binary' : 'utf8');
      const task = { id, dir: jobDir, status: 'queued', pid: null, createdAt: nowIso(), startedAt: null, finishedAt: null, exitCode: null, error: null, child: null };
      tasks.set(id, task);
      task.walrusPath = walrusPath;
      await writeState(task);
      queue.push(task);
      schedule();
      return res.status(202).json({ id, status: task.status });
    } catch (error) {
      const status = /missing or not executable/.test(error.message) ? 503 : 500;
      return res.status(status).json({ error: error.message });
    }
  }
  app.post('/tasks', upload.single('configFile'), (req, res) => {
    if (stopping) return res.status(503).json({ error: 'Server is shutting down' });
    const pending = submitTask(req, res);
    admissions.add(pending);
    pending.finally(() => admissions.delete(pending)).catch(() => {});
  });

  app.get('/tasks/:id', async (req, res) => {
    try {
      const { id } = req.params;
      if (!TASK_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid task ID' });
      const task = tasks.get(id);
      const jobDir = path.join(jobsDir, id);
      if (!task && !(await exists(jobDir))) return res.status(404).json({ error: 'Task not found' });
      const state = task || await readState(jobDir);
      const resultText = await readText(path.join(jobDir, RESULT_FILE));
      return res.json({
        id,
        status: state?.status || 'unknown',
        pid: state?.pid ?? null,
        startedAt: state?.startedAt ?? null,
        finishedAt: state?.finishedAt ?? null,
        exitCode: state?.exitCode ?? null,
        error: state?.error ?? null,
        hasResult: resultText !== null,
        resultText: resultText ?? undefined,
        result: resultText ?? undefined,
        logTail: await readTail(path.join(jobDir, LOG_FILE), MAX_LOG_TAIL_BYTES),
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.delete('/tasks/:id', async (req, res) => {
    try {
      const { id } = req.params;
      if (!TASK_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid task ID' });
      const task = tasks.get(id);
      if (!task) return res.status(404).json({ error: 'Task not found or is no longer active' });
      await cancelTask(task);
      return res.json({ id, status: task.status });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/tasks', async (_req, res) => {
    try {
      if (!(await exists(jobsDir))) return res.json([]);
      const output = [];
      for (const id of await fsp.readdir(jobsDir)) {
        if (!TASK_ID_RE.test(id)) continue;
        const state = await readState(path.join(jobsDir, id));
        if (state) output.push({ id, ...state });
      }
      output.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return res.json(output);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.locals.ready = ready;
  app.locals.shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      await ready;
      await Promise.allSettled([...admissions]);
      const outcomes = await Promise.allSettled([...tasks.values()].map((task) =>
        cancelTask(task, 'failed', 'Interrupted by server shutdown; resubmit explicitly')));
      const deadline = Date.now() + 10000;
      while (active.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const failure = outcomes.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (active.size) throw new Error('Timed out waiting for solver processes to close');
    })();
    return shutdownPromise;
  };
  app.locals.tasks = tasks;
  app.locals.jobsDir = jobsDir;
  return app;
}

async function startServer() {
  const port = Number(process.env.PORT || 3001);
  const app = createApp();
  await app.locals.ready;
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, (error) => error ? reject(error) : resolve(instance));
    instance.once('error', reject);
  });
  console.log(`Bodealer service listening on port ${server.address().port}`);
  console.log(`Walrus: ${resolveWalrusPath()}`);
  console.log(`Jobs dir: ${app.locals.jobsDir}`);
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Bound shutdown even if a client holds an HTTP connection open.
    const timer = setTimeout(() => process.exit(1), 15000);
    try {
      const closed = new Promise((resolve) => server.close(resolve));
      await app.locals.shutdown();
      server.closeAllConnections();
      await closed;
      clearTimeout(timer);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    } catch (error) {
      console.error('Shutdown failed:', error);
      process.exitCode = 1;
      // Keep the deadline armed if any solver or connection remains stuck.
      timer.unref();
    }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (require.main === module) startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { createApp, executableName, resolveWalrusPath, validateWalrus, startServer };

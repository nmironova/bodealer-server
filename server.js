'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { randomUUID } = require('crypto');
const multer = require('multer');

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

async function writeState(task) {
  const { child, dir, ...state } = task;
  await fsp.writeFile(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
}

async function unixDescendants(rootPid) {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=']);
  const children = new Map();
  for (const line of stdout.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const result = [];
  const visit = (pid) => {
    for (const childPid of children.get(pid) || []) {
      visit(childPid);
      result.push(childPid);
    }
  };
  visit(rootPid);
  return result;
}

function signalIfAlive(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function terminateProcessTree(task, platform = process.platform) {
  if (!task.child || task.child.exitCode !== null || !task.pid) return;
  if (platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/pid', String(task.pid), '/T', '/F'], { windowsHide: true });
    } catch (error) {
      if (task.child.exitCode === null) throw error;
    }
    return;
  }

  const descendants = await unixDescendants(task.pid);
  for (const pid of descendants) signalIfAlive(pid, 'SIGTERM');
  signalIfAlive(task.pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const pid of [...descendants, task.pid]) signalIfAlive(pid, 'SIGKILL');
}

function createApp(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const jobsDir = options.jobsDir || path.join(rootDir, 'jobs');
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const tasks = new Map();
  const app = express();
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
    const child = spawn(walrusPath, args, {
      cwd: path.dirname(walrusPath),
      windowsHide: true,
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
    child.once('error', (error) => {
      spawnError = error;
      if (task.status !== 'cancelled') {
        finishTask(task, { status: 'failed', error: error.message }).catch((stateError) => {
          task.error = `${error.message}; state write failed: ${stateError.message}`;
        });
      }
    });
    child.once('close', (code, signal) => {
      task.exitCode = code;
      task.signal = signal;
      task.child = null;
      let stateUpdate;
      if (task.status !== 'cancelled' && !spawnError) {
        stateUpdate = finishTask(task, code === 0
          ? { status: 'completed', error: null }
          : { status: 'failed', error: `Walrus exited with code ${code}${signal ? ` (${signal})` : ''}` });
      } else {
        stateUpdate = writeState(task);
      }
      stateUpdate.catch((error) => {
        task.error = task.error || `State write failed: ${error.message}`;
      }).finally(() => logStream.end());
    });
    await writeState(task);
  }

  app.post('/tasks', upload.single('configFile'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'configFile is required' });
      const walrusPath = resolveWalrusPath({ env, platform, rootDir });
      await validateWalrus(walrusPath, platform);
      await fsp.mkdir(jobsDir, { recursive: true });
      const id = randomUUID();
      const jobDir = path.join(jobsDir, id);
      await fsp.mkdir(jobDir);
      const encoding = String(req.body.encoding || 'utf8').toLowerCase();
      const configText = req.file.buffer.toString(encoding === 'win1251' ? 'binary' : 'utf8');
      const finalConfig = selectTaskInConfig(configText, req.body.taskName);
      await fsp.writeFile(path.join(jobDir, CONFIG_FILE), finalConfig.endsWith('\n') ? finalConfig : `${finalConfig}\r\n`, encoding === 'win1251' ? 'binary' : 'utf8');
      const task = { id, dir: jobDir, status: 'queued', pid: null, createdAt: nowIso(), startedAt: null, finishedAt: null, exitCode: null, error: null, child: null };
      tasks.set(id, task);
      await writeState(task);
      try {
        await startJob(task, walrusPath);
      } catch (error) {
        await finishTask(task, { status: 'failed', error: error.message });
      }
      return res.status(202).json({ id, status: task.status });
    } catch (error) {
      const status = /missing or not executable/.test(error.message) ? 503 : 500;
      return res.status(status).json({ error: error.message });
    }
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
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'cancelled';
        task.finishedAt = nowIso();
        await writeState(task);
        try {
          await terminateProcessTree(task, platform);
        } catch (error) {
          task.error = `Cancellation failed: ${error.message}`;
          await writeState(task);
          return res.status(500).json({ error: task.error });
        }
      }
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

  app.locals.tasks = tasks;
  app.locals.jobsDir = jobsDir;
  return app;
}

async function startServer() {
  const port = Number(process.env.PORT || 3001);
  const app = createApp();
  await fsp.mkdir(app.locals.jobsDir, { recursive: true });
  return app.listen(port, () => {
    console.log(`Bodealer service listening on http://localhost:${port}`);
    console.log(`Walrus: ${resolveWalrusPath()}`);
    console.log(`Jobs dir: ${app.locals.jobsDir}`);
  });
}

if (require.main === module) startServer();

module.exports = { createApp, executableName, resolveWalrusPath, validateWalrus, startServer };

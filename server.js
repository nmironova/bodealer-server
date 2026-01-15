'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const multer = require('multer');
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- Config (edit these) ----
const PORT = process.env.PORT || 3001;

const ROOT_DIR = __dirname;
const EXES_DIR = path.join(ROOT_DIR, 'exes');
const JOBS_DIR = path.join(ROOT_DIR, 'jobs');

const EXE_1 = 'Walrus.exe';

// Files produced/used inside each job folder
const CONFIG_FILE = 'start_from.txt';
const LOG_FILE = 'logs.txt';        
const RESULT_FILE = 'rescalc.txt';  
const STATE_FILE = 'state.json';

const MAX_LOG_TAIL_BYTES = 64 * 1024; // 64KB tail in responses

// In-memory registry (good enough for 1-instance service).
// If you need multi-instance / restarts, read state.json on startup.
const tasks = new Map(); // id -> { id, dir, status, pid, startedAt, finishedAt, exitCode, error }

// ---- Helpers ----
async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function fileExists(p) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function selectTaskInConfig(configText, taskName) {
    if (!taskName) return configText;
  
    const lines = configText.split(/\r?\n/);
  
    const taskRe = /^\s*(\/\/\s*)?TASK NAME\s*:\s*([A-Za-z0-9_]+)\s*$/;
    let found = false;
  
    const out = lines.map((line) => {
      const m = line.match(taskRe);
      if (!m) return line;
  
      const name = m[2];
      if (name === taskName) {
        found = true;
        return `TASK NAME:${name}`;
      }
      return `//TASK NAME:${name}`;
    });
  
    if (!found) {
      // Fail fast: better than silently running wrong task.
      throw new Error(`TASK NAME:${taskName} not found in config`);
    }
  
    return out.join('\r\n') + '\r\n';
  }
  
  function payloadToConfigTxt(payload) {

    if (typeof payload.configBase64 === 'string') {
        const buf = Buffer.from(payload.configBase64, 'base64');
        const text = buf.toString('utf8');
        return selectTaskInConfig(text, payload.taskName);
      }
    // mode 1: raw config
    if (typeof payload.configText === 'string') {
      return payload.configText.endsWith('\n')
        ? payload.configText
        : payload.configText + '\r\n';
    }
  
    // mode 2: template + select a task
    if (typeof payload.configTemplateText === 'string') {
      return selectTaskInConfig(payload.configTemplateText, payload.taskName);
    }
  
    throw new Error('Payload must provide configText OR configTemplateText (+ taskName)');
  }
  
async function readTail(filePath, maxBytes) {
  if (!(await fileExists(filePath))) return null;

  const stat = await fsp.stat(filePath);
  const size = stat.size;
  const start = Math.max(0, size - maxBytes);

  const fd = await fsp.open(filePath, 'r');
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    await fd.close();
  }
}

async function readJsonIfExists(filePath) {
  if (!(await fileExists(filePath))) return null;
  const raw = await fsp.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    // If result is not JSON, return raw text
    return raw;
  }
}

async function writeState(jobDir, stateObj) {
  const p = path.join(jobDir, STATE_FILE);
  await fsp.writeFile(p, JSON.stringify(stateObj, null, 2), 'utf8');
}

// Start the job process
async function startJob(task) {
  const jobDir = task.dir;

  task.status = 'running';
  task.startedAt = nowIso();
  await writeState(jobDir, {
    id: task.id,
    status: task.status,
    startedAt: task.startedAt,
  });

  // Run Walrus.exe from the shared EXES_DIR
  const exePath = path.join(EXES_DIR, EXE_1);

  if (!(await fileExists(exePath))) {
    throw new Error(`Exe not found: ${exePath}`);
  }

  const configPath = path.join(jobDir, CONFIG_FILE);
  const resultPath = path.join(jobDir, RESULT_FILE);
  const args = ['-exitondone', '-cfgname', configPath, '-logresult', resultPath];

  console.log('exePath=', exePath);
  console.log('args=', args);
  args
  const child = spawn(
  'cmd.exe',
    ['/c', 'start', '""', '/D', EXES_DIR, EXE_1, ...args],
    {
       windowsHide: true,      // hides the *launcher*, not the started window
       detached: true,
       stdio: 'ignore',        // important: no pipes
    }
  );

  child.unref();

  task.pid = null;

  // log stdout/stderr into job log
  const logPath = path.join(jobDir, LOG_FILE);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  await writeState(jobDir, {
    id: task.id,
    status: task.status,
    startedAt: task.startedAt,
    pid: task.pid,
    args,
    exePath,
  });

  child.stdout.on('data', (chunk) => logStream.write(chunk));
  child.stderr.on('data', (chunk) => logStream.write(chunk));

  child.on('error', async (err) => {
    task.status = 'failed';
    task.error = String(err?.message || err);
    task.finishedAt = nowIso();
    await writeState(jobDir, {
      id: task.id,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      error: task.error,
      pid: task.pid ?? null,
    });
    logStream.end();
  });

  child.on('close', async (code) => {
    task.exitCode = code;
    task.finishedAt = nowIso();

    const hasResult = await fileExists(resultPath);

    // if your exe returns 0 but result is not always produced, relax this rule
    task.status = code === 0 ? 'completed' : 'failed';

    await writeState(jobDir, {
      id: task.id,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      exitCode: task.exitCode,
      hasResult,
    });

    logStream.end();
  });
}


// ---- Routes ----

// Create task
app.post('/tasks', upload.single('configFile'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'configFile is required' });
      }
  
      await ensureDir(JOBS_DIR);
  
      const id = randomUUID();
      const jobDir = path.join(JOBS_DIR, id);
      await ensureDir(jobDir);
  
      const taskName = req.body.taskName;
      const encoding = (req.body.encoding || 'utf8').toLowerCase();
  
      // NOTE: "binary" is NOT real win1251. If you truly need cp1251, use iconv-lite (tell me).
      const configText =
        encoding === 'win1251'
          ? req.file.buffer.toString('binary')
          : req.file.buffer.toString('utf8');
  
      const finalConfig = taskName ? selectTaskInConfig(configText, taskName) : configText;
  
      // Write config file with the name your exes expect
      await fsp.writeFile(
        path.join(jobDir, CONFIG_FILE),
        finalConfig.endsWith('\n') ? finalConfig : finalConfig + '\r\n',
        encoding === 'win1251' ? 'binary' : 'utf8'
      );
  
      const task = {
        id,
        dir: jobDir,
        status: 'queued',
        pid: null,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        error: null,
      };
      tasks.set(id, task);
  
      await writeState(jobDir, { id, status: task.status, createdAt: nowIso() });
  
      startJob(task).catch(async (e) => {
        task.status = 'failed';
        task.error = String(e?.message || e);
        task.finishedAt = nowIso();
        await writeState(jobDir, {
          id: task.id,
          status: task.status,
          error: task.error,
          finishedAt: task.finishedAt,
          pid: task.pid ?? null,
        });
      });
  
      return res.status(202).json({ id, status: task.status });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

// Get status (+ tail logs + result if exists)
app.get('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const task = tasks.get(id);
    // If server restarted, task might not be in memory. Fall back to disk.
    const jobDir = path.join(JOBS_DIR, id);
    if (!task && !(await fileExists(jobDir))) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const logTail = await readTail(path.join(jobDir, LOG_FILE), MAX_LOG_TAIL_BYTES);
    const result = await readJsonIfExists(path.join(jobDir, RESULT_FILE));
    const state = await readJsonIfExists(path.join(jobDir, STATE_FILE));

    return res.json({
      id,
      status: task?.status ?? state?.status ?? 'unknown',
      pid: task?.pid ?? null,
      startedAt: task?.startedAt ?? state?.startedAt ?? null,
      finishedAt: task?.finishedAt ?? state?.finishedAt ?? null,
      exitCode: task?.exitCode ?? state?.exitCode ?? null,
      error: task?.error ?? state?.error ?? null,
      hasResult: !!result,
      result,
      logTail,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Optional: list tasks (reads jobs folder)
app.get('/tasks', async (_req, res) => {
  try {
    if (!(await fileExists(JOBS_DIR))) return res.json([]);

    const ids = await fsp.readdir(JOBS_DIR);
    // Return lightweight info
    const out = [];
    for (const id of ids) {
      const jobDir = path.join(JOBS_DIR, id);
      const state = await readJsonIfExists(path.join(jobDir, STATE_FILE));
      out.push({ id, ...(state || {}) });
    }
    // newest first if createdAt exists
    out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- Boot ----
app.listen(PORT, async () => {
  await ensureDir(JOBS_DIR);
  console.log(`Bodealer service listening on http://localhost:${PORT}`);
  console.log(`Exes dir: ${EXES_DIR}`);
  console.log(`Jobs dir: ${JOBS_DIR}`);
});

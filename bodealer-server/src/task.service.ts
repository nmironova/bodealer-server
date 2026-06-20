import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  TaskListItemDTO,
  TaskListResponseDTO,
  TaskResponseDTO,
  TaskStatus,
} from './dto/task.response.dto';
import { TaskFilterDTO } from './dto/task.filter.dto';
import { TaskCreateDTO } from './dto/task.create.dto';

const EXE_1 = 'Walrus.exe';
const CONFIG_FILE = 'start_from.txt';
const LOG_FILE = 'logs.txt';
const RESULT_FILE = 'rescalc.txt';
const STATE_FILE = 'state.json';
const MAX_LOG_TAIL_BYTES = 64 * 1024;

type UploadedConfigFile = {
  buffer: Buffer;
};

type TaskState = {
  id: string;
  dir: string;
  status: TaskStatus;
  pid: number | null;
  createdAt?: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
};

@Injectable()
export class TaskService implements OnModuleInit {
  private readonly rootDir = this.resolveRootDir();
  private readonly exesDir = path.join(this.rootDir, 'exes');
  private readonly jobsDir = path.join(this.rootDir, 'jobs');
  private readonly tasks = new Map<string, TaskState>();

  async onModuleInit(): Promise<void> {
    await this.ensureDir(this.jobsDir);
  }

  getHello(): string {
    return 'Hello World!';
  }

  async getList(filter: TaskFilterDTO): Promise<TaskListResponseDTO> {
    const {
      status,
      limit = 50,
      offset = 0,
      sortBy = 'createdAt',
      sortDir = 'desc',
    } = filter;

    if (!(await this.fileExists(this.jobsDir))) {
      return { tasks: [], totalElements: 0 };
    }

    const ids = await fsp.readdir(this.jobsDir);
    let tasks: TaskListItemDTO[] = [];

    for (const id of ids) {
      const jobDir = path.join(this.jobsDir, id);
      const state = await this.readJsonIfExists<TaskListItemDTO>(
        path.join(jobDir, STATE_FILE),
      );

      if (state && typeof state === 'object') {
        tasks.push({ ...state, id });
      }
    }

    if (status) {
      tasks = tasks.filter((task) => task.status === status);
    }

    const dir = sortDir === 'asc' ? 1 : -1;
    tasks.sort((a, b) => {
      const aValue = String(a[sortBy] ?? '');
      const bValue = String(b[sortBy] ?? '');
      const cmp = aValue.localeCompare(bValue);
      return (cmp || a.id.localeCompare(b.id)) * dir;
    });

    return {
      tasks: tasks.slice(offset, offset + limit),
      totalElements: tasks.length,
    };
  }

  async getById(id: string): Promise<TaskResponseDTO> {
    this.assertTaskId(id);

    const task = this.tasks.get(id);
    const jobDir = path.join(this.jobsDir, id);

    if (!task && !(await this.fileExists(jobDir))) {
      throw new NotFoundException(`Task with id ${id} not found`);
    }

    const state = await this.readJsonIfExists<Partial<TaskState>>(
      path.join(jobDir, STATE_FILE),
    );
    const result = await this.readJsonIfExists(path.join(jobDir, RESULT_FILE));
    const logTail = await this.readTail(
      path.join(jobDir, LOG_FILE),
      MAX_LOG_TAIL_BYTES,
    );

    return {
      id,
      status: task?.status ?? state?.status ?? TaskStatus.Failed,
      pid: task?.pid ?? state?.pid ?? null,
      startedAt: task?.startedAt ?? state?.startedAt ?? null,
      finishedAt: task?.finishedAt ?? state?.finishedAt ?? null,
      exitCode: task?.exitCode ?? state?.exitCode ?? null,
      error: task?.error ?? state?.error ?? null,
      hasResult: result !== null,
      result,
      logTail,
    };
  }

  async create(
    taskCreateDTO: TaskCreateDTO,
    configFile?: UploadedConfigFile,
  ): Promise<TaskResponseDTO> {
    await this.ensureDir(this.jobsDir);

    const id = randomUUID();
    const jobDir = path.join(this.jobsDir, id);
    await this.ensureDir(jobDir);

    const encoding = taskCreateDTO.encoding ?? 'utf8';
    const configText = this.payloadToConfigTxt(taskCreateDTO, configFile);

    await fsp.writeFile(
      path.join(jobDir, CONFIG_FILE),
      configText.endsWith('\n') ? configText : `${configText}\r\n`,
      encoding === 'win1251' ? 'binary' : 'utf8',
    );

    const task: TaskState = {
      id,
      dir: jobDir,
      status: TaskStatus.Queued,
      pid: null,
      createdAt: this.nowIso(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
    };

    this.tasks.set(id, task);
    await this.writeState(jobDir, {
      id,
      status: task.status,
      createdAt: task.createdAt,
    });

    this.startJob(task).catch(async (err) => {
      task.status = TaskStatus.Failed;
      task.error = String(err?.message || err);
      task.finishedAt = this.nowIso();
      await this.writeState(jobDir, {
        id: task.id,
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        error: task.error,
        pid: task.pid,
      });
    });

    return this.getById(id);
  }

  async delete(id: string): Promise<void> {
    this.assertTaskId(id);

    const jobDir = path.join(this.jobsDir, id);

    if (!(await this.fileExists(jobDir))) {
      throw new NotFoundException(`Task with id ${id} not found`);
    }

    this.tasks.delete(id);
    await fsp.rm(jobDir, { recursive: true, force: true });
  }

  private async startJob(task: TaskState): Promise<void> {
    const exePath = path.join(this.exesDir, EXE_1);

    if (!(await this.fileExists(exePath))) {
      throw new InternalServerErrorException(`Exe not found: ${exePath}`);
    }

    const configPath = path.join(task.dir, CONFIG_FILE);
    const resultPath = path.join(task.dir, RESULT_FILE);
    const logPath = path.join(task.dir, LOG_FILE);
    const args = ['-exitondone', '-cfgname', configPath, '-logresult', resultPath];
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    task.status = TaskStatus.Running;
    task.startedAt = this.nowIso();
    await this.writeState(task.dir, {
      id: task.id,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      pid: task.pid,
      args,
      exePath,
    });

    const child = spawn(exePath, args, {
      cwd: this.exesDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    task.pid = child.pid ?? null;
    await this.writeState(task.dir, {
      id: task.id,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      pid: task.pid,
      args,
      exePath,
    });

    child.stdout?.on('data', (chunk) => logStream.write(chunk));
    child.stderr?.on('data', (chunk) => logStream.write(chunk));

    child.on('error', async (err) => {
      task.status = TaskStatus.Failed;
      task.error = String(err?.message || err);
      task.finishedAt = this.nowIso();
      await this.writeState(task.dir, {
        id: task.id,
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        error: task.error,
        pid: task.pid,
      });
      logStream.end();
    });

    child.on('close', async (code) => {
      task.exitCode = code;
      task.finishedAt = this.nowIso();
      task.status = code === 0 ? TaskStatus.Completed : TaskStatus.Failed;

      const hasResult = await this.fileExists(resultPath);
      await this.writeState(task.dir, {
        id: task.id,
        status: task.status,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        exitCode: task.exitCode,
        hasResult,
        pid: task.pid,
        error: task.error,
      });

      logStream.end();
    });
  }

  private payloadToConfigTxt(
    payload: TaskCreateDTO,
    configFile?: UploadedConfigFile,
  ): string {
    if (configFile) {
      const encoding = payload.encoding ?? 'utf8';
      const configText =
        encoding === 'win1251'
          ? configFile.buffer.toString('binary')
          : configFile.buffer.toString('utf8');

      return payload.taskName
        ? this.selectTaskInConfig(configText, payload.taskName)
        : configText;
    }

    if (typeof payload.configBase64 === 'string') {
      const text = Buffer.from(payload.configBase64, 'base64').toString('utf8');
      return this.selectTaskInConfig(text, payload.taskName);
    }

    if (typeof payload.configText === 'string') {
      return payload.configText;
    }

    if (typeof payload.configTemplateText === 'string') {
      return this.selectTaskInConfig(payload.configTemplateText, payload.taskName);
    }

    throw new BadRequestException(
      'Request must provide configFile, configText, configBase64, or configTemplateText',
    );
  }

  private selectTaskInConfig(configText: string, taskName?: string): string {
    if (!taskName) {
      return configText;
    }

    const lines = configText.split(/\r?\n/);
    const taskRe = /^\s*(\/\/\s*)?TASK NAME\s*:\s*([A-Za-z0-9_]+)\s*$/;
    let found = false;

    const out = lines.map((line) => {
      const match = line.match(taskRe);

      if (!match) {
        return line;
      }

      const name = match[2];
      if (name === taskName) {
        found = true;
        return `TASK NAME:${name}`;
      }

      return `//TASK NAME:${name}`;
    });

    if (!found) {
      throw new BadRequestException(`TASK NAME:${taskName} not found in config`);
    }

    return `${out.join('\r\n')}\r\n`;
  }

  private resolveRootDir(): string {
    const candidates = [
      process.cwd(),
      path.resolve(process.cwd(), '..'),
      path.resolve(__dirname, '..', '..', '..'),
    ];

    return (
      candidates.find((candidate) => fs.existsSync(path.join(candidate, 'exes'))) ??
      process.cwd()
    );
  }

  private assertTaskId(id: string): void {
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidRe.test(id)) {
      throw new NotFoundException(`Task with id ${id} not found`);
    }
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await fsp.mkdir(dirPath, { recursive: true });
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private async writeState(
    jobDir: string,
    stateObj: Record<string, unknown>,
  ): Promise<void> {
    await fsp.writeFile(
      path.join(jobDir, STATE_FILE),
      JSON.stringify(stateObj, null, 2),
      'utf8',
    );
  }

  private async readTail(
    filePath: string,
    maxBytes: number,
  ): Promise<string | null> {
    if (!(await this.fileExists(filePath))) {
      return null;
    }

    const stat = await fsp.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = await fsp.open(filePath, 'r');

    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      await fd.close();
    }
  }

  private async readJsonIfExists<T = unknown>(filePath: string): Promise<T | null> {
    if (!(await this.fileExists(filePath))) {
      return null;
    }

    const raw = await fsp.readFile(filePath, 'utf8');

    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }
}

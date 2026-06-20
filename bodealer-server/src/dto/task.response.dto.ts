import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export enum TaskStatus {
  Queued = 'queued',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

export class TaskResponseDTO {
  @IsString()
  id: string;

  @IsString()
  status: TaskStatus;

  @IsOptional()
  @IsNumber()
  pid?: number | null;

  @IsOptional()
  @IsString()
  startedAt?: string | null;

  @IsOptional()
  @IsString()
  finishedAt?: string | null;

  @IsOptional()
  @IsNumber()
  exitCode?: number | null;

  @IsOptional()
  @IsString()
  error?: string | null;

  @IsBoolean()
  hasResult: boolean;

  @IsOptional()
  @IsString()
  resultText?: string | null;

  @IsOptional()
  @IsString()
  resultFileName?: string | null;

  @IsOptional()
  @IsString()
  logTail?: string | null;
}

export class TaskListItemDTO {
  @IsString()
  id: string;

  @IsString()
  status: TaskStatus;

  @IsOptional()
  @IsString()
  createdAt?: string;

  @IsOptional()
  @IsString()
  startedAt?: string;

  @IsOptional()
  @IsString()
  finishedAt?: string;

  @IsOptional()
  @IsNumber()
  exitCode?: number | null;

  @IsOptional()
  @IsString()
  error?: string | null;
}

export class TaskListResponseDTO {
  tasks: TaskListItemDTO[];
  totalElements: number;
}

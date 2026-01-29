import { IsNumber, IsString } from 'class-validator';

export enum TaskStatus {
  InProgress = 'InProgress',
  CompletedOk = 'CompletedOk',
  CompletedFail = 'CompletedFail',
}

export class TaskResponseDTO {
  @IsString()
  id: string;

  @IsString()
  name: string;

  @IsNumber()
  boardsNumber: number;

  status: TaskStatus;
}

export class TaskListResponseDTO {
  tasks: TaskResponseDTO[];
  totalElements: number;
}

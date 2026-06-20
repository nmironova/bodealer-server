import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min, IsIn } from 'class-validator';
import { TaskStatus } from './task.response.dto';

export type TaskSortBy = 'createdAt' | 'startedAt' | 'finishedAt' | 'status';
export type SortDir = 'asc' | 'desc';

export class TaskFilterDTO {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @IsOptional()
  @IsIn(['createdAt', 'startedAt', 'finishedAt', 'status'] as const)
  sortBy: TaskSortBy = 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'] as const)
  sortDir: SortDir = 'asc';
}

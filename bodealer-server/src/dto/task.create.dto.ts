import { IsNumber, IsOptional, IsString } from 'class-validator';

export class TaskCreateDTO {
  @IsString()
  name: string;

  @IsOptional()
  @IsNumber()
  boardsNumber?: number = 10000;

  // TODO: add something meangfull
}

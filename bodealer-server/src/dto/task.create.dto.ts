import { IsIn, IsOptional, IsString } from 'class-validator';

export class TaskCreateDTO {
  @IsOptional()
  @IsString()
  taskName?: string;

  @IsOptional()
  @IsString()
  configText?: string;

  @IsOptional()
  @IsString()
  configTemplateText?: string;

  @IsOptional()
  @IsString()
  configBase64?: string;

  @IsOptional()
  @IsIn(['utf8', 'win1251'])
  encoding?: 'utf8' | 'win1251' = 'utf8';
}

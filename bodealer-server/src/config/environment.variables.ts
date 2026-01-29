import { IsNumber } from 'class-validator';

export class EnvironmentVariables {
  @IsNumber()
  PORT: number = 3000;
}

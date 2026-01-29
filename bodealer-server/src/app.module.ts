import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { EnvironmentVariables } from './config/environment.variables';
import { validateConfig } from './config/env.vaiables.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      expandVariables: true,
      validationSchema: EnvironmentVariables,
      validate: validateConfig,
    }),
  ],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {}
}

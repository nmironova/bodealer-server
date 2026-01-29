import { Test, TestingModule } from '@nestjs/testing';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';

describe('AppController', () => {
  let taskController: TaskController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [TaskController],
      providers: [TaskController],
    }).compile();

    taskController = app.get<TaskController>(TaskController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(taskController.getHello()).toBe('Hello World!');
    });
  });
});

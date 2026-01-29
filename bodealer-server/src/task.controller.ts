import {
  Controller,
  Get,
  HttpCode,
  Post,
  Body,
  Param,
  Query,
  Delete,
} from '@nestjs/common';
import { TaskService } from './task.service';
import { TaskResponseDTO, TaskListResponseDTO } from './dto/task.response.dto';
import { TaskFilterDTO } from './dto/task.filter.dto';
import { TaskCreateDTO } from './dto/task.create.dto';

@Controller('tasks')
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Get('hello')
  getHello() {
    return this.taskService.getHello();
  }

  @Get()
  getTasks(@Query() filter: TaskFilterDTO): Promise<TaskListResponseDTO> {
    return this.taskService.getList(filter);
  }

  @Get('/:id')
  getById(@Param('id') id: string): Promise<TaskResponseDTO> {
    return this.taskService.getById(id);
  }

  @HttpCode(201)
  @Post('')
  async createTask(
    @Body() taskCreateDTO: TaskCreateDTO,
  ): Promise<TaskResponseDTO> {
    return this.taskService.create(taskCreateDTO);
  }

  @Delete(':id')
  delete(@Param('id') id: string): Promise<void> {
    return this.taskService.delete(id);
  }
}

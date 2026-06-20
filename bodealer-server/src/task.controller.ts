import {
  Controller,
  Get,
  HttpCode,
  Post,
  Body,
  Param,
  Query,
  Delete,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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

  @HttpCode(202)
  @Post('')
  @UseInterceptors(FileInterceptor('configFile'))
  async createTask(
    @Body() taskCreateDTO: TaskCreateDTO,
    @UploadedFile() configFile?: { buffer: Buffer },
  ): Promise<TaskResponseDTO> {
    return this.taskService.create(taskCreateDTO, configFile);
  }

  @Delete(':id')
  delete(@Param('id') id: string): Promise<void> {
    return this.taskService.delete(id);
  }
}

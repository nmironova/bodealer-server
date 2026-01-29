import { Injectable, NotFoundException } from '@nestjs/common';
import {
  TaskResponseDTO,
  TaskStatus,
  TaskListResponseDTO,
} from './dto/task.response.dto';
import { TaskFilterDTO } from './dto/task.filter.dto';
import { TaskCreateDTO } from './dto/task.create.dto';
import { randomUUID } from 'crypto';

import { mockedTasks } from './mocked.tasks.list';

@Injectable()
export class TaskService {
  getHello(): string {
    return 'Hello World!';
  }

  async getList(filter: TaskFilterDTO): Promise<TaskListResponseDTO> {
    const {
      status,
      limit = 50,
      offset = 0,
      sortBy = 'name',
      sortDir = 'asc',
    } = filter;

    let items = mockedTasks;

    if (status) {
      items = items.filter((t) => t.status === status);
    }
    const dir = sortDir === 'asc' ? 1 : -1;

    const sorted = [...items].sort((a, b) => {
      let cmp = 0;

      switch (sortBy) {
        case 'boardsNumber':
          cmp = a.boardsNumber - b.boardsNumber;
          break;

        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;

        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
      }

      if (cmp === 0) {
        cmp = a.id.localeCompare(b.id);
      }

      return cmp * dir;
    });

    const totalElements = sorted.length;
    const tasks = sorted.slice(offset, offset + limit);

    return {
      tasks,
      totalElements,
    };
  }

  async getById(id: string): Promise<TaskResponseDTO> {
    const task = mockedTasks.find((t) => t.id === id);

    if (!task) {
      throw new NotFoundException(`Task with id ${id} not found`);
    }

    return task;
  }

  async create(taskCreateDTO: TaskCreateDTO): Promise<TaskResponseDTO> {
    const statuses: TaskStatus[] = [
      TaskStatus.InProgress,
      TaskStatus.CompletedOk,
      TaskStatus.CompletedFail,
    ];

    const task: TaskResponseDTO = {
      id: randomUUID(),
      name: taskCreateDTO.name,
      boardsNumber: taskCreateDTO.boardsNumber,
      status: statuses[Math.floor(Math.random() * statuses.length)],
    };

    mockedTasks.push(task);

    return task;
  }

  async delete(id: string): Promise<void> {
    const index = mockedTasks.findIndex((t) => t.id === id);

    if (index === -1) {
      throw new NotFoundException(`Task with id ${id} not found`);
    }

    mockedTasks.splice(index, 1);
  }
}

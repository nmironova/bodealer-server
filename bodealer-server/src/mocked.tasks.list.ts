import { TaskResponseDTO, TaskStatus } from './dto/task.response.dto';

export const mockedTasks: TaskResponseDTO[] = [
  {
    id: 'af53bf7f-bf77-42b9-8122-ad8334494b0d',
    name: '3NT or 2NT question',
    boardsNumber: 10000,
    status: TaskStatus.CompletedOk,
  },
  {
    id: '29cbd962-cb9a-4393-81ef-a8b497d311d6',
    name: 'Lead in 3NT',
    boardsNumber: 20000,
    status: TaskStatus.CompletedOk,
  },
  {
    id: 'a35fed09-fbea-4eda-b7df-0dfb47b44bf1',
    name: 'Invit or game forcing?',
    boardsNumber: 20000,
    status: TaskStatus.CompletedFail,
  },
  {
    id: '4801952e-f6b6-4694-ba0b-627a926f3ce71',
    name: 'Invit or game forcing with opponents bidding',
    boardsNumber: 20000,
    status: TaskStatus.InProgress,
  },
  {
    id: '99762d65-7676-4f9c-94d0-838d1b82a17a',
    name: 'Pass or 3h?',
    boardsNumber: 40000,
    status: TaskStatus.InProgress,
  },
];

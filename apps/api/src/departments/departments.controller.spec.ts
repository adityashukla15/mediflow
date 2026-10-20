import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DepartmentsController } from './departments.controller.js';
import { DepartmentsService } from './departments.service.js';

describe('DepartmentsController', () => {
  let controller: DepartmentsController;
  let departmentsService: {
    findAll: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    departmentsService = {
      findAll: vi.fn(),
      findOne: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DepartmentsController],
      providers: [
        {
          provide: DepartmentsService,
          useValue: departmentsService,
        },
      ],
    }).compile();

    controller = module.get<DepartmentsController>(DepartmentsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates listing departments to the service', async () => {
    const departments = [{ id: 'dept-1', name: 'Cardiology' }];
    departmentsService.findAll.mockResolvedValue(departments);

    await expect(controller.findAll()).resolves.toEqual(departments);
    expect(departmentsService.findAll).toHaveBeenCalledOnce();
  });

  it('delegates department details to the service', async () => {
    const department = { id: 'dept-1', name: 'Cardiology' };
    departmentsService.findOne.mockResolvedValue(department);

    await expect(controller.findOne('dept-1')).resolves.toEqual(department);
    expect(departmentsService.findOne).toHaveBeenCalledWith('dept-1');
  });

  it('delegates department creation to the service', async () => {
    const dto = { name: 'Cardiology', description: 'Heart care department' };
    const department = { id: 'dept-1', ...dto };
    departmentsService.create.mockResolvedValue(department);

    await expect(controller.create(dto)).resolves.toEqual(department);
    expect(departmentsService.create).toHaveBeenCalledWith(dto);
  });

  it('delegates department updates to the service', async () => {
    const dto = { name: 'Neurology' };
    const department = { id: 'dept-1', ...dto };
    departmentsService.update.mockResolvedValue(department);

    await expect(controller.update('dept-1', dto)).resolves.toEqual(department);
    expect(departmentsService.update).toHaveBeenCalledWith('dept-1', dto);
  });
});

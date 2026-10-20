import { Test, TestingModule } from '@nestjs/testing';
import { vi, type Mock } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DepartmentsService } from './departments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('DepartmentsService', () => {
  let service: DepartmentsService;
  let prisma: {
    department: {
      findMany: Mock;
      findUnique: Mock;
      create: Mock;
      update: Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      department: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepartmentsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<DepartmentsService>(DepartmentsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('returns only active departments', async () => {
    prisma.department.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(prisma.department.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  });

  it('creates a department', async () => {
    const dto = { name: 'Cardiology', description: 'Heart care' };
    prisma.department.create.mockResolvedValue({ id: 'dept-1', ...dto });

    await expect(service.create(dto)).resolves.toMatchObject(dto);
  });

  it('rejects duplicate department names', async () => {
    prisma.department.create.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.create({ name: 'Cardiology', description: 'Heart care' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws when a department does not exist', async () => {
    prisma.department.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects duplicate department names during update', async () => {
    prisma.department.findUnique.mockResolvedValue({
      id: 'dept-1',
      name: 'Cardiology',
      isActive: true,
    });

    prisma.department.update.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.update('dept-1', { name: 'Cardiology' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

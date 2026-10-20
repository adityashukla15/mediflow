import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DoctorsController } from './doctors.controller.js';
import { DoctorsService } from './doctors.service.js';
import { UserRole } from '../generated/prisma/client.js';

describe('DoctorsController', () => {
  let controller: DoctorsController;
  let doctorsService: {
    findAll: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    setSchedule: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    doctorsService = {
      findAll: vi.fn(),
      findOne: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      setSchedule: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DoctorsController],
      providers: [
        { provide: DoctorsService, useValue: doctorsService },
      ],
    }).compile();

    controller = module.get<DoctorsController>(DoctorsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates listing doctors to the service', async () => {
    doctorsService.findAll.mockResolvedValue([]);

    await expect(controller.findAll()).resolves.toEqual([]);
    expect(doctorsService.findAll).toHaveBeenCalledOnce();
  });

  it('delegates doctor details to the service', async () => {
    const doctor = { id: 'doctor-1' };
    doctorsService.findOne.mockResolvedValue(doctor);

    await expect(controller.findOne('doctor-1')).resolves.toEqual(doctor);
    expect(doctorsService.findOne).toHaveBeenCalledWith('doctor-1');
  });

  it('delegates doctor creation to the service', async () => {
    const dto = {
      userId: 'user-1',
      departmentId: 'dept-1',
      fullName: 'Dr Test',
      specialization: 'Cardiology',
      consultationFee: 500,
    };
    const doctor = { id: 'doctor-1', ...dto };
    doctorsService.create.mockResolvedValue(doctor);

    await expect(controller.create(dto)).resolves.toEqual(doctor);
    expect(doctorsService.create).toHaveBeenCalledWith(dto);
  });
});

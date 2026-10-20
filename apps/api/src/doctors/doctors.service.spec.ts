import { Test, TestingModule } from '@nestjs/testing';
import { vi, type Mock } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DoctorsService } from './doctors.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UserRole, UserStatus, DayOfWeek } from '../generated/prisma/client.js';

describe('DoctorsService', () => {
  let service: DoctorsService;
  let prisma: {
    doctorProfile: {
      findMany: Mock;
      findUnique: Mock;
      findFirst: Mock;
      create: Mock;
      update: Mock;
    };
    user: { findUnique: Mock };
    department: { findUnique: Mock };
    $transaction: Mock;
  };

  beforeEach(async () => {
    prisma = {
      doctorProfile: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      user: { findUnique: vi.fn() },
      department: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DoctorsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<DoctorsService>(DoctorsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('lists only active doctor profiles', async () => {
    prisma.doctorProfile.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(prisma.doctorProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          department: {
            is: { isActive: true },
          },
          user: {
            is: {
              role: UserRole.DOCTOR,
              status: UserStatus.ACTIVE,
            },
          },
        },
      }),
    );
  });

  it('rejects a missing doctor user account', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.create({
        userId: 'user-1',
        departmentId: 'dept-1',
        fullName: 'Dr Test',
        specialization: 'Cardiology',
        consultationFee: 500,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a user without the DOCTOR role', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: UserRole.PATIENT,
      status: UserStatus.ACTIVE,
    });

    await expect(
      service.create({
        userId: 'user-1',
        departmentId: 'dept-1',
        fullName: 'Dr Test',
        specialization: 'Cardiology',
        consultationFee: 500,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a schedule when start time is not before end time', async () => {
    await expect(
      service.setSchedule('doctor-1', {
        dayOfWeek: DayOfWeek.MONDAY,
        startTime: '13:00',
        endTime: '09:00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFoundException when the doctor is unavailable', async () => {
    prisma.doctorProfile.findFirst.mockResolvedValue(null);

    await expect(service.findOne('doctor-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

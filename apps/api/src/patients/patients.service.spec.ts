import { Test, TestingModule } from '@nestjs/testing';
import { vi, type Mock } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PatientsService } from './patients.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UserRole } from '../generated/prisma/client.js';

describe('PatientsService', () => {
  let service: PatientsService;
  let prisma: {
    patientProfile: { findUnique: Mock; upsert: Mock };
    user: { findUnique: Mock };
  };

  beforeEach(async () => {
    prisma = {
      patientProfile: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PatientsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<PatientsService>(PatientsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('returns the logged-in patient profile', async () => {
    const profile = { id: 'profile-1', userId: 'user-1', fullName: 'Test Patient' };
    prisma.patientProfile.findUnique.mockResolvedValue(profile);

    await expect(service.getMyProfile('user-1')).resolves.toEqual(profile);
    expect(prisma.patientProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
  });

  it('throws when the patient profile does not exist', async () => {
    prisma.patientProfile.findUnique.mockResolvedValue(null);

    await expect(service.getMyProfile('user-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates or updates only the authenticated patient profile', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.PATIENT });
    const profile = { userId: 'user-1', fullName: 'Test Patient' };
    prisma.patientProfile.upsert.mockResolvedValue(profile);

    await expect(
      service.updateMyProfile('user-1', { fullName: 'Test Patient' }),
    ).resolves.toEqual(profile);

    expect(prisma.patientProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        create: expect.objectContaining({ userId: 'user-1', fullName: 'Test Patient' }),
        update: expect.objectContaining({ fullName: 'Test Patient' }),
      }),
    );
  });

  it('rejects non-patient accounts from managing patient profiles', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: UserRole.DOCTOR });

    await expect(
      service.updateMyProfile('doctor-1', { fullName: 'Someone' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.patientProfile.upsert).not.toHaveBeenCalled();
  });

  it('forbids profile updates for a missing user account', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.updateMyProfile('missing-user', { fullName: 'Test Patient' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.patientProfile.upsert).not.toHaveBeenCalled();
  });
});

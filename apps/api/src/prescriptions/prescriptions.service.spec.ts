
import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategies.js';
import { PrescriptionsService } from './prescriptions.service.js';

describe('PrescriptionsService', () => {
  let service: PrescriptionsService;

  const prisma = {
    doctorProfile: { findFirst: vi.fn() },
    patientProfile: { findUnique: vi.fn() },
    appointment: { findFirst: vi.fn() },
    prescription: { findMany: vi.fn() },
    $transaction: vi.fn(),
  } as unknown as PrismaService;

  const patientUser = {
    id: 'patient-user-1',
    email: 'patient@example.com',
    role: UserRole.PATIENT,
  } as AuthenticatedUser;

  const doctorUser = {
    id: 'doctor-user-1',
    email: 'doctor@example.com',
    role: UserRole.DOCTOR,
  } as AuthenticatedUser;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PrescriptionsService(prisma);
  });

  it('blocks patients from creating prescriptions', async () => {
    await expect(
      service.create(patientUser, {
        patientId: '11111111-1111-4111-8111-111111111111',
        appointmentId: '22222222-2222-4222-8222-222222222222',
        items: [
          {
            medicineName: 'Medicine A',
            dosage: '1 tablet',
            frequency: 'Twice daily',
            durationDays: 5,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks doctors without an active doctor profile', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue(null);

    await expect(
      service.create(doctorUser, {
        patientId: '11111111-1111-4111-8111-111111111111',
        appointmentId: '22222222-2222-4222-8222-222222222222',
        items: [
          {
            medicineName: 'Medicine A',
            dosage: '1 tablet',
            frequency: 'Twice daily',
            durationDays: 5,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an appointment not belonging to the selected patient and doctor', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({
      id: 'doctor-profile-1',
    } as never);

    vi.mocked(prisma.patientProfile.findUnique).mockResolvedValue({
      id: 'patient-profile-1',
    } as never);

    vi.mocked(prisma.appointment.findFirst).mockResolvedValue(null);

    await expect(
      service.create(doctorUser, {
        patientId: '11111111-1111-4111-8111-111111111111',
        appointmentId: '22222222-2222-4222-8222-222222222222',
        items: [
          {
            medicineName: 'Medicine A',
            dosage: '1 tablet',
            frequency: 'Twice daily',
            durationDays: 5,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns only the signed-in patient’s prescription history', async () => {
    vi.mocked(prisma.patientProfile.findUnique).mockResolvedValue({
      id: 'patient-profile-1',
    } as never);

    vi.mocked(prisma.prescription.findMany).mockResolvedValue([] as never);

    await service.findAll(patientUser);

    expect(prisma.prescription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { patientId: 'patient-profile-1' },
      }),
    );
  });

  it('creates a prescription and writes an audit log in the same transaction', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({
      id: 'doctor-profile-1',
    } as never);

    vi.mocked(prisma.patientProfile.findUnique).mockResolvedValue({
      id: 'patient-profile-1',
    } as never);

    vi.mocked(prisma.appointment.findFirst).mockResolvedValue({
      id: 'appointment-1',
    } as never);

    const createdPrescription = {
      id: 'prescription-1',
      items: [{ id: 'item-1', medicineName: 'Medicine A' }],
    };

    const tx = {
      prescription: {
        create: vi.fn().mockResolvedValue(createdPrescription),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };

    vi.mocked(prisma.$transaction).mockImplementation(
      ((callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx)) as never,
    );

    const result = await service.create(doctorUser, {
      patientId: '11111111-1111-4111-8111-111111111111',
      appointmentId: '22222222-2222-4222-8222-222222222222',
      items: [
        {
          medicineName: 'Medicine A',
          dosage: '1 tablet',
          frequency: 'Twice daily',
          durationDays: 5,
        },
      ],
    });

    expect(result).toEqual(createdPrescription);
    expect(tx.prescription.create).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: doctorUser.id,
          entityType: 'Prescription',
          entityId: 'prescription-1',
        }),
      }),
    );
  });
});

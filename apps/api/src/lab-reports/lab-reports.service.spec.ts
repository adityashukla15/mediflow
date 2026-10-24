
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategies.js';
import { LabReportsService } from './lab-reports.service.js';

describe('LabReportsService', () => {
  let service: LabReportsService;

  const prisma = {
    doctorProfile: { findFirst: vi.fn() },
    patientProfile: { findUnique: vi.fn() },
    appointment: { findFirst: vi.fn() },
    document: { findUnique: vi.fn() },
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
    service = new LabReportsService(prisma);
  });

  it('blocks patients from creating lab reports', async () => {
    await expect(
      service.create(patientUser, {
        patientId: '11111111-1111-4111-8111-111111111111',
        testName: 'Blood Test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks doctors without an active doctor profile', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue(null);

    await expect(
      service.create(doctorUser, {
        patientId: '11111111-1111-4111-8111-111111111111',
        testName: 'Blood Test',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a document belonging to another patient', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({
      id: 'doctor-profile-1',
    } as never);

    vi.mocked(prisma.patientProfile.findUnique).mockResolvedValue({
      id: 'patient-profile-1',
    } as never);

    vi.mocked(prisma.document.findUnique).mockResolvedValue({
      id: 'document-1',
      patientId: 'different-patient-profile',
    } as never);

    await expect(
      service.create(doctorUser, {
        patientId: '11111111-1111-4111-8111-111111111111',
        testName: 'Blood Test',
        documentId: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates a lab report and writes an audit log in the same transaction', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({
      id: 'doctor-profile-1',
    } as never);

    vi.mocked(prisma.patientProfile.findUnique).mockResolvedValue({
      id: 'patient-profile-1',
    } as never);

    const createdReport = {
      id: 'lab-report-1',
      patientId: 'patient-profile-1',
      doctorId: 'doctor-profile-1',
      testName: 'Blood Test',
      status: 'PENDING',
    };

    const tx = {
      labReport: {
        create: vi.fn().mockResolvedValue(createdReport),
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
      testName: 'Blood Test',
    });

    expect(result).toEqual(createdReport);
    expect(tx.labReport.create).toHaveBeenCalled();

    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: doctorUser.id,
          entityType: 'LabReport',
          entityId: 'lab-report-1',
        }),
      }),
    );
  });
});


import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AppointmentStatus, UserRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppointmentsService } from './appointments.service.js';

describe('AppointmentsService', () => {
  let service: AppointmentsService;

  const prisma = {
    patientProfile: { findUnique: vi.fn() },
    doctorProfile: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    doctorSchedule: { findMany: vi.fn() },
    appointment: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };

  const patientUser = {
    id: 'user-patient-1',
    email: 'patient@example.com',
    role: UserRole.PATIENT,
  };

  beforeEach(async () => {
    vi.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppointmentsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AppointmentsService>(AppointmentsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('rejects booking when the patient profile does not exist', async () => {
    prisma.patientProfile.findUnique.mockResolvedValue(null);

    const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    await expect(
      service.create(patientUser, {
        doctorId: 'doctor-1',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.doctorProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid appointment time range', async () => {
    const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await expect(
      service.create(patientUser, {
        doctorId: 'doctor-1',
        startAt: startAt.toISOString(),
        endAt: startAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.patientProfile.findUnique).not.toHaveBeenCalled();
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects booking by a non-patient account', async () => {
    await expect(
      service.create(
        { ...patientUser, role: UserRole.DOCTOR },
        {
          doctorId: 'doctor-1',
          startAt: new Date(Date.now() + 86_400_000).toISOString(),
          endAt: new Date(Date.now() + 87_000_000).toISOString(),
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects access to another patient appointment', async () => {
    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      patientId: 'different-patient-profile',
      doctorId: 'doctor-1',
      status: AppointmentStatus.SCHEDULED,
    });

    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'my-patient-profile',
    });

    await expect(
      service.reschedule(patientUser, 'appointment-1', {
        startAt: new Date(Date.now() + 172_800_000).toISOString(),
        endAt: new Date(Date.now() + 174_600_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('creates an appointment using the patient profile ID', async () => {
    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    startAt.setHours(10, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
    });
    prisma.doctorProfile.findFirst.mockResolvedValue({
      id: 'doctor-profile-1',
    });
    prisma.doctorSchedule.findMany.mockResolvedValue([
      { startTime: '09:00', endTime: '17:00' },
    ]);
    prisma.appointment.findFirst.mockResolvedValue(null);
    prisma.appointment.create.mockResolvedValue({
      id: 'appointment-1',
      patientId: 'patient-profile-1',
      doctorId: 'doctor-profile-1',
      startAt,
      endAt,
      status: AppointmentStatus.SCHEDULED,
    });

    await service.create(patientUser, {
      doctorId: 'doctor-profile-1',
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
    });

    expect(prisma.appointment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          patientId: 'patient-profile-1',
          doctorId: 'doctor-profile-1',
          startAt,
          endAt,
        }),
      }),
    );
  });

  it('rejects booking when the doctor already has an overlapping appointment', async () => {
    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    startAt.setHours(10, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
    });
    prisma.doctorProfile.findFirst.mockResolvedValue({
      id: 'doctor-profile-1',
    });
    prisma.doctorSchedule.findMany.mockResolvedValue([
      { startTime: '09:00', endTime: '17:00' },
    ]);
    prisma.appointment.findFirst.mockResolvedValue({
      id: 'existing-appointment',
    });

    await expect(
      service.create(patientUser, {
        doctorId: 'doctor-profile-1',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects booking with an inactive or unavailable doctor', async () => {
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
    });
    prisma.doctorProfile.findFirst.mockResolvedValue(null);

    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    startAt.setHours(10, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    await expect(
      service.create(patientUser, {
        doctorId: 'doctor-profile-1',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects booking outside the doctor active schedule', async () => {
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
    });
    prisma.doctorProfile.findFirst.mockResolvedValue({
      id: 'doctor-profile-1',
    });
    prisma.doctorSchedule.findMany.mockResolvedValue([
      { startTime: '09:00', endTime: '17:00' },
    ]);

    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    startAt.setHours(18, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    await expect(
      service.create(patientUser, {
        doctorId: 'doctor-profile-1',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  it('rejects rescheduling when the appointment does not exist', async () => {
    prisma.appointment.findUnique.mockResolvedValue(null);

    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    await expect(
      service.reschedule(patientUser, 'missing-appointment', {
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('allows a patient to cancel their own scheduled appointment', async () => {
    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      patientId: 'patient-profile-1',
      doctorId: 'doctor-profile-1',
      status: AppointmentStatus.SCHEDULED,
    });
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
    });
    prisma.appointment.update.mockResolvedValue({
      id: 'appointment-1',
      status: AppointmentStatus.CANCELLED,
    });

    await service.updateStatus(patientUser, 'appointment-1', {
      status: AppointmentStatus.CANCELLED,
    });

    expect(prisma.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'appointment-1' },
        data: { status: AppointmentStatus.CANCELLED },
      }),
    );
  });

  it('prevents a patient from confirming their own appointment', async () => {
    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      patientId: 'patient-profile-1',
      doctorId: 'doctor-profile-1',
      status: AppointmentStatus.SCHEDULED,
    });
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
    });

    await expect(
      service.updateStatus(patientUser, 'appointment-1', {
        status: AppointmentStatus.CONFIRMED,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('prevents a doctor from accessing another doctor appointment', async () => {
    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      patientId: 'patient-profile-1',
      doctorId: 'different-doctor-profile',
      status: AppointmentStatus.SCHEDULED,
    });
    prisma.doctorProfile.findUnique.mockResolvedValue({
      id: 'my-doctor-profile',
    });

    await expect(
      service.reschedule(
        {
          id: 'doctor-user-1',
          email: 'doctor@example.com',
          role: UserRole.DOCTOR,
        },
        'appointment-1',
        {
          startAt: new Date(Date.now() + 172_800_000).toISOString(),
          endAt: new Date(Date.now() + 174_600_000).toISOString(),
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('rejects rescheduling a cancelled appointment', async () => {
    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      patientId: 'patient-profile-1',
      doctorId: 'doctor-profile-1',
      status: AppointmentStatus.CANCELLED,
    });
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
    });

    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    await expect(
      service.reschedule(patientUser, 'appointment-1', {
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('rejects rescheduling into an occupied doctor time slot', async () => {
    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      patientId: 'patient-profile-1',
      doctorId: 'doctor-profile-1',
      status: AppointmentStatus.SCHEDULED,
    });
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
    });
    prisma.doctorProfile.findFirst.mockResolvedValue({
      id: 'doctor-profile-1',
    });
    prisma.doctorSchedule.findMany.mockResolvedValue([
      { startTime: '09:00', endTime: '17:00' },
    ]);
    prisma.appointment.findFirst.mockResolvedValue({
      id: 'existing-appointment',
    });

    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    startAt.setHours(10, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    await expect(
      service.reschedule(patientUser, 'appointment-1', {
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.appointment.findFirst).toHaveBeenCalled();
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('rejects status updates when the appointment does not exist', async () => {
    prisma.appointment.findUnique.mockResolvedValue(null);

    await expect(
      service.updateStatus(patientUser, 'missing-appointment', {
        status: AppointmentStatus.CANCELLED,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });
});

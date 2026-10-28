import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import {
  AppointmentStatus,
  EmailOutboxEvent,
  UserRole,
} from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailOutboxService } from '../email/email-outbox.service.js';
import { AppointmentRemindersProcessor } from '../appointment-reminders/appointment-reminders.processor.js';
import { AppointmentsService } from './appointments.service.js';

describe('AppointmentsService', () => {
  let service: AppointmentsService;

  const prisma = {
    patientProfile: {
      findUnique: vi.fn(),
    },
    doctorProfile: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    doctorSchedule: {
      findMany: vi.fn(),
    },
    appointment: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };

  const notificationsService = {
    createAppointmentEventNotifications: vi.fn(),
  };

  const emailOutboxService = {
    enqueueAppointmentEmails: vi.fn(),
  };

  const appointmentRemindersService = {
    scheduleForAppointment: vi.fn(),
    cancelForAppointment: vi.fn(),
  };

  const patientUser = {
    id: 'user-patient-1',
    email: 'patient@example.com',
    role: UserRole.PATIENT,
  };

  const doctorUser = {
    id: 'user-doctor-1',
    email: 'doctor@example.com',
    role: UserRole.DOCTOR,
  };

  const expectAppointmentNotification = (event: string) => {
    expect(
      notificationsService.createAppointmentEventNotifications,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: 'appointment-1',
        event,
        recipients: expect.arrayContaining([
          expect.objectContaining({ userId: patientUser.id }),
          expect.objectContaining({ userId: doctorUser.id }),
        ]),
      }),
    );
  };

  const makeAppointment = (
    status: AppointmentStatus = AppointmentStatus.SCHEDULED,
  ) => ({
    id: 'appointment-1',
    patientId: 'patient-profile-1',
    doctorId: 'doctor-profile-1',
    status,
    startAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    endAt: new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000,
    ),
    updatedAt: new Date('2026-10-27T10:00:00.000Z'),
  });

  beforeEach(async () => {
    vi.resetAllMocks();

    notificationsService.createAppointmentEventNotifications.mockResolvedValue({
      createdCount: 0,
    });

    emailOutboxService.enqueueAppointmentEmails.mockResolvedValue(undefined);

    appointmentRemindersService.scheduleForAppointment.mockResolvedValue(
      undefined,
    );
    appointmentRemindersService.cancelForAppointment.mockResolvedValue(
      undefined,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppointmentsService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: NotificationsService,
          useValue: notificationsService,
        },
        {
          provide: EmailOutboxService,
          useValue: emailOutboxService,
        },
        {
          provide: AppointmentRemindersProcessor,
          useValue: appointmentRemindersService,
        },
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
    expect(
      notificationsService.createAppointmentEventNotifications,
    ).not.toHaveBeenCalled();
    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).not.toHaveBeenCalled();
    expect(
      appointmentRemindersService.scheduleForAppointment,
    ).not.toHaveBeenCalled();
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
      ...makeAppointment(),
      patientId: 'different-patient-profile',
    });

    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'my-patient-profile',
      userId: patientUser.id,
    });

    await expect(
      service.reschedule(patientUser, 'appointment-1', {
        startAt: new Date(Date.now() + 172_800_000).toISOString(),
        endAt: new Date(Date.now() + 174_600_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('creates an appointment, schedules reminders, and enqueues emails for both participants', async () => {
    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    startAt.setHours(10, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      userId: patientUser.id,
      fullName: 'Test Patient',
    });

    prisma.doctorProfile.findFirst.mockResolvedValue({
      id: 'doctor-profile-1',
      userId: doctorUser.id,
      fullName: 'Test Doctor',
      user: { email: doctorUser.email },
      specialization: 'General Medicine',
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

    expect(
      appointmentRemindersService.scheduleForAppointment,
    ).toHaveBeenCalledWith('appointment-1');

    expectAppointmentNotification('BOOKED');

    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).toHaveBeenCalledTimes(1);

    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).toHaveBeenCalledWith({
      appointmentId: 'appointment-1',
      event: EmailOutboxEvent.BOOKED,
      patientEmail: patientUser.email,
      patientName: 'Test Patient',
      doctorEmail: doctorUser.email,
      doctorName: 'Test Doctor',
      startAt,
      endAt,
    });
  });

  it('does not fail booking if reminder scheduling fails', async () => {
    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    startAt.setHours(10, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      fullName: 'Test Patient',
    });

    prisma.doctorProfile.findFirst.mockResolvedValue({
      id: 'doctor-profile-1',
      userId: doctorUser.id,
      fullName: 'Test Doctor',
      user: { email: doctorUser.email },
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

    appointmentRemindersService.scheduleForAppointment.mockRejectedValueOnce(
      new Error('Simulated reminder database failure'),
    );

    await expect(
      service.create(patientUser, {
        doctorId: 'doctor-profile-1',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      }),
    ).resolves.toMatchObject({ id: 'appointment-1' });

    expect(prisma.appointment.create).toHaveBeenCalledTimes(1);
    expectAppointmentNotification('BOOKED');
    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).toHaveBeenCalledTimes(1);
  });

  it('does not fail booking if email enqueueing fails', async () => {
    const startAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    startAt.setHours(10, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      userId: patientUser.id,
      fullName: 'Test Patient',
    });

    prisma.doctorProfile.findFirst.mockResolvedValue({
      id: 'doctor-profile-1',
      userId: doctorUser.id,
      fullName: 'Test Doctor',
      user: { email: doctorUser.email },
      specialization: 'General Medicine',
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

    emailOutboxService.enqueueAppointmentEmails.mockRejectedValueOnce(
      new Error('Simulated outbox database failure'),
    );

    await expect(
      service.create(patientUser, {
        doctorId: 'doctor-profile-1',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      }),
    ).resolves.toMatchObject({ id: 'appointment-1' });

    expect(prisma.appointment.create).toHaveBeenCalledTimes(1);
    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).toHaveBeenCalledTimes(1);
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
      userId: doctorUser.id,
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
    expect(
      notificationsService.createAppointmentEventNotifications,
    ).not.toHaveBeenCalled();
    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).not.toHaveBeenCalled();
    expect(
      appointmentRemindersService.scheduleForAppointment,
    ).not.toHaveBeenCalled();
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
      userId: doctorUser.id,
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

  it('reschedules an appointment and refreshes its reminders', async () => {
    const existing = makeAppointment();
    const startAt = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    startAt.setHours(11, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    prisma.appointment.findUnique.mockResolvedValue(existing);
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      userId: patientUser.id,
    });
    prisma.doctorProfile.findFirst.mockResolvedValue({
      id: 'doctor-profile-1',
      userId: doctorUser.id,
    });
    prisma.doctorSchedule.findMany.mockResolvedValue([
      { startTime: '09:00', endTime: '17:00' },
    ]);
    prisma.appointment.findFirst.mockResolvedValue(null);
    prisma.appointment.update.mockResolvedValue({
      ...existing,
      startAt,
      endAt,
    });

    await service.reschedule(patientUser, 'appointment-1', {
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
    });

    expect(prisma.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'appointment-1' },
        data: { startAt, endAt },
      }),
    );

    expect(
      appointmentRemindersService.scheduleForAppointment,
    ).toHaveBeenCalledWith('appointment-1');
    expectAppointmentNotification('RESCHEDULED');
  });

  it('notifies both participants when a doctor confirms an appointment', async () => {
    prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
    prisma.doctorProfile.findUnique.mockResolvedValue({
      id: 'doctor-profile-1',
      userId: doctorUser.id,
    });
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      userId: patientUser.id,
    });
    prisma.appointment.update.mockResolvedValue({
      ...makeAppointment(AppointmentStatus.CONFIRMED),
      updatedAt: new Date('2026-10-27T10:01:00.000Z'),
    });

    await service.updateStatus(doctorUser, 'appointment-1', {
      status: AppointmentStatus.CONFIRMED,
    });

    expect(prisma.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'appointment-1' },
        data: { status: AppointmentStatus.CONFIRMED },
      }),
    );

    expectAppointmentNotification('CONFIRMED');
    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).not.toHaveBeenCalled();
    expect(
      appointmentRemindersService.cancelForAppointment,
    ).not.toHaveBeenCalled();
  });

  it('cancels reminders and enqueues cancellation emails when an appointment is cancelled', async () => {
    const appointment = makeAppointment();

    prisma.appointment.findUnique.mockResolvedValue(appointment);

    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      userId: patientUser.id,
      user: { email: patientUser.email },
    });
    prisma.doctorProfile.findUnique.mockResolvedValue({
      id: 'doctor-profile-1',
      userId: doctorUser.id,
      user: { email: doctorUser.email },
    });

    prisma.appointment.update.mockResolvedValue({
      ...makeAppointment(AppointmentStatus.CANCELLED),
      patient: { fullName: 'Test Patient' },
      doctor: { fullName: 'Test Doctor' },
      updatedAt: new Date('2026-10-27T10:02:00.000Z'),
    });

    await service.updateStatus(patientUser, 'appointment-1', {
      status: AppointmentStatus.CANCELLED,
    });

    expect(
      appointmentRemindersService.cancelForAppointment,
    ).toHaveBeenCalledWith('appointment-1');
    expectAppointmentNotification('CANCELLED');

    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).toHaveBeenCalledTimes(1);

    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).toHaveBeenCalledWith({
      appointmentId: 'appointment-1',
      event: EmailOutboxEvent.CANCELLED,
      patientEmail: patientUser.email,
      patientName: 'Test Patient',
      doctorEmail: doctorUser.email,
      doctorName: 'Test Doctor',
      startAt: appointment.startAt,
      endAt: appointment.endAt,
    });
  });

  it.each([
    AppointmentStatus.COMPLETED,
    AppointmentStatus.NO_SHOW,
  ])(
    'rejects a doctor attempting the %s transition if not permitted',
    async (status) => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());

      prisma.doctorProfile.findUnique.mockResolvedValue({
        id: 'doctor-profile-1',
        userId: doctorUser.id,
      });

      await expect(
        service.updateStatus(doctorUser, 'appointment-1', { status }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(prisma.appointment.update).not.toHaveBeenCalled();
      expect(
        appointmentRemindersService.cancelForAppointment,
      ).not.toHaveBeenCalled();
    },
  );

  it('does not fail cancellation if email enqueueing fails', async () => {
    prisma.appointment.findUnique.mockResolvedValue(makeAppointment());

    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      userId: patientUser.id,
      user: { email: patientUser.email },
    });
    prisma.doctorProfile.findUnique.mockResolvedValue({
      id: 'doctor-profile-1',
      userId: doctorUser.id,
      user: { email: doctorUser.email },
    });

    prisma.appointment.update.mockResolvedValue({
      ...makeAppointment(AppointmentStatus.CANCELLED),
      patient: { fullName: 'Test Patient' },
      doctor: { fullName: 'Test Doctor' },
      updatedAt: new Date('2026-10-27T10:02:00.000Z'),
    });

    emailOutboxService.enqueueAppointmentEmails.mockRejectedValueOnce(
      new Error('Simulated outbox database failure'),
    );

    await expect(
      service.updateStatus(patientUser, 'appointment-1', {
        status: AppointmentStatus.CANCELLED,
      }),
    ).resolves.toMatchObject({
      id: 'appointment-1',
      status: AppointmentStatus.CANCELLED,
    });

    expect(prisma.appointment.update).toHaveBeenCalledTimes(1);
    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).toHaveBeenCalledTimes(1);
    expect(
      appointmentRemindersService.cancelForAppointment,
    ).toHaveBeenCalledWith('appointment-1');
  });

  it('does not fail cancellation if reminder cancellation fails', async () => {
    prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      userId: patientUser.id,
      user: { email: patientUser.email },
    });
    prisma.doctorProfile.findUnique.mockResolvedValue({
      id: 'doctor-profile-1',
      userId: doctorUser.id,
      user: { email: doctorUser.email },
    });

    prisma.appointment.update.mockResolvedValue({
      ...makeAppointment(AppointmentStatus.CANCELLED),
      patient: { fullName: 'Test Patient' },
      doctor: { fullName: 'Test Doctor' },
      updatedAt: new Date('2026-10-27T10:02:00.000Z'),
    });

    appointmentRemindersService.cancelForAppointment.mockRejectedValueOnce(
      new Error('Simulated reminder database failure'),
    );

    await expect(
      service.updateStatus(patientUser, 'appointment-1', {
        status: AppointmentStatus.CANCELLED,
      }),
    ).resolves.toMatchObject({
      id: 'appointment-1',
      status: AppointmentStatus.CANCELLED,
    });
  });

  it('does not create another notification when the status is unchanged', async () => {
    prisma.appointment.findUnique
      .mockResolvedValueOnce(makeAppointment(AppointmentStatus.CONFIRMED))
      .mockResolvedValueOnce(makeAppointment(AppointmentStatus.CONFIRMED));

    prisma.doctorProfile.findUnique.mockResolvedValue({
      id: 'doctor-profile-1',
      userId: doctorUser.id,
    });

    await service.updateStatus(doctorUser, 'appointment-1', {
      status: AppointmentStatus.CONFIRMED,
    });

    expect(prisma.appointment.update).not.toHaveBeenCalled();
    expect(
      notificationsService.createAppointmentEventNotifications,
    ).not.toHaveBeenCalled();
    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).not.toHaveBeenCalled();
    expect(
      appointmentRemindersService.cancelForAppointment,
    ).not.toHaveBeenCalled();
  });

  it('prevents a patient from confirming their own appointment', async () => {
    prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      userId: patientUser.id,
    });

    await expect(
      service.updateStatus(patientUser, 'appointment-1', {
        status: AppointmentStatus.CONFIRMED,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.appointment.update).not.toHaveBeenCalled();
    expect(
      notificationsService.createAppointmentEventNotifications,
    ).not.toHaveBeenCalled();
    expect(
      emailOutboxService.enqueueAppointmentEmails,
    ).not.toHaveBeenCalled();
    expect(
      appointmentRemindersService.cancelForAppointment,
    ).not.toHaveBeenCalled();
  });

  it('prevents a doctor from accessing another doctor appointment', async () => {
    prisma.appointment.findUnique.mockResolvedValue({
      ...makeAppointment(),
      doctorId: 'different-doctor-profile',
    });
    prisma.doctorProfile.findUnique.mockResolvedValue({
      id: 'my-doctor-profile',
      userId: doctorUser.id,
    });

    await expect(
      service.reschedule(doctorUser, 'appointment-1', {
        startAt: new Date(Date.now() + 172_800_000).toISOString(),
        endAt: new Date(Date.now() + 174_600_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it('rejects rescheduling a cancelled appointment', async () => {
    prisma.appointment.findUnique.mockResolvedValue(
      makeAppointment(AppointmentStatus.CANCELLED),
    );
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      userId: patientUser.id,
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
    expect(
      notificationsService.createAppointmentEventNotifications,
    ).not.toHaveBeenCalled();
  });

  it('rejects rescheduling into an occupied doctor time slot', async () => {
    prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'patient-profile-1',
      userId: patientUser.id,
    });
    prisma.doctorProfile.findFirst.mockResolvedValue({
      id: 'doctor-profile-1',
      userId: doctorUser.id,
      fullName: 'Test Doctor',
      specialization: 'General Medicine',
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
    expect(
      notificationsService.createAppointmentEventNotifications,
    ).not.toHaveBeenCalled();
    expect(
      appointmentRemindersService.scheduleForAppointment,
    ).not.toHaveBeenCalled();
  });

  it('rejects status updates when the appointment does not exist', async () => {
    prisma.appointment.findUnique.mockResolvedValue(null);

    await expect(
      service.updateStatus(patientUser, 'missing-appointment', {
        status: AppointmentStatus.CANCELLED,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.appointment.update).not.toHaveBeenCalled();
    expect(
      appointmentRemindersService.cancelForAppointment,
    ).not.toHaveBeenCalled();
  });
});

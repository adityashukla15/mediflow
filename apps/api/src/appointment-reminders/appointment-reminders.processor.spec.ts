
import { AppointmentRemindersProcessor } from './appointment-reminders.processor.js';
import {
  AppointmentReminderKind,
  AppointmentReminderStatus,
  AppointmentStatus,
} from '../generated/prisma/client.js';

describe('AppointmentRemindersProcessor', () => {
  const prisma = {
    appointment: {
      findUnique: vi.fn(),
    },
    appointmentReminder: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };

  const emailService = {
    sendAppointmentReminder: vi.fn(),
  };

  let processor: AppointmentRemindersProcessor;

  beforeEach(() => {
    vi.resetAllMocks();

    processor = new AppointmentRemindersProcessor(
      prisma as any,
      emailService as any,
    );
  });

  it('schedules the expected reminders for a future appointment without duplicating them', async () => {
    const startAt = new Date(Date.now() + 26 * 60 * 60 * 1000);

    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      status: AppointmentStatus.SCHEDULED,
      startAt,
    });

    prisma.appointmentReminder.findUnique.mockResolvedValue(null);

    await processor.scheduleForAppointment('appointment-1');

    expect(prisma.appointmentReminder.create).toHaveBeenCalledTimes(2);

    expect(prisma.appointmentReminder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          appointmentId: 'appointment-1',
          kind: AppointmentReminderKind.TWENTY_FOUR_HOURS,
          status: AppointmentReminderStatus.PENDING,
        }),
      }),
    );

    expect(prisma.appointmentReminder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          appointmentId: 'appointment-1',
          kind: AppointmentReminderKind.ONE_HOUR,
          status: AppointmentReminderStatus.PENDING,
        }),
      }),
    );

    prisma.appointmentReminder.findUnique.mockResolvedValue({
      id: 'existing-reminder',
      appointmentId: 'appointment-1',
      kind: AppointmentReminderKind.ONE_HOUR,
      status: AppointmentReminderStatus.PENDING,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      sentAt: null,
    });

    await processor.scheduleForAppointment('appointment-1');

    expect(prisma.appointmentReminder.update).toHaveBeenCalled();
  });

  it('schedules future reminders and delivers only due pending reminders', async () => {
    const startAt = new Date(Date.now() + 26 * 60 * 60 * 1000);
    const reminderTime = new Date(startAt.getTime() - 60 * 60 * 1000);

    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      status: AppointmentStatus.SCHEDULED,
      startAt,
    });

    prisma.appointmentReminder.findUnique.mockResolvedValue(null);

    await processor.scheduleForAppointment('appointment-1');

    expect(prisma.appointmentReminder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: AppointmentReminderKind.ONE_HOUR,
          scheduledAt: expect.any(Date),
        }),
      }),
    );

    prisma.appointmentReminder.findMany.mockResolvedValue([
      {
        id: 'reminder-1',
        appointmentId: 'appointment-1',
        kind: AppointmentReminderKind.ONE_HOUR,
        status: AppointmentReminderStatus.PENDING,
        scheduledAt: reminderTime,
      },
    ]);

    prisma.appointmentReminder.updateMany.mockResolvedValue({ count: 1 });

    // After the atomic claim, the database record is PROCESSING.
    prisma.appointmentReminder.findUnique.mockResolvedValueOnce({
      id: 'reminder-1',
      appointmentId: 'appointment-1',
      kind: AppointmentReminderKind.ONE_HOUR,
      status: AppointmentReminderStatus.PROCESSING,
      scheduledAt: reminderTime,
      sentAt: null,
    });

    prisma.appointment.findUnique.mockResolvedValueOnce({
      id: 'appointment-1',
      status: AppointmentStatus.SCHEDULED,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
      patient: {
        fullName: 'Jane Doe',
        user: { email: 'jane@example.com' },
      },
      doctor: { fullName: 'Dr. Smith' },
    });

    emailService.sendAppointmentReminder.mockResolvedValue(true);

    await processor.processDueReminders();

    expect(emailService.sendAppointmentReminder).toHaveBeenCalledWith(
      'jane@example.com',
      expect.objectContaining({
        patientName: 'Jane Doe',
        doctorName: 'Dr. Smith',
      }),
      AppointmentReminderKind.ONE_HOUR,
    );

    expect(prisma.appointmentReminder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AppointmentReminderStatus.SENT,
        }),
      }),
    );
  });

  it('does not send an already sent reminder again', async () => {
    const reminderId = 'reminder-1';

    prisma.appointmentReminder.findMany.mockResolvedValue([
      {
        id: reminderId,
        appointmentId: 'appointment-1',
        kind: AppointmentReminderKind.ONE_HOUR,
        status: AppointmentReminderStatus.PENDING,
        scheduledAt: new Date(Date.now() - 60 * 1000),
      },
    ]);

    // A reminder that cannot be claimed must not be processed.
    prisma.appointmentReminder.updateMany.mockResolvedValue({ count: 0 });

    prisma.appointmentReminder.findUnique.mockResolvedValue({
      id: reminderId,
      appointmentId: 'appointment-1',
      kind: AppointmentReminderKind.ONE_HOUR,
      status: AppointmentReminderStatus.SENT,
      scheduledAt: new Date(Date.now() - 60 * 1000),
      sentAt: new Date(),
    });

    await processor.processDueReminders();

    expect(prisma.appointmentReminder.findUnique).not.toHaveBeenCalled();
    expect(emailService.sendAppointmentReminder).not.toHaveBeenCalled();
  });

  it('marks duplicate processing attempts as no-ops and keeps the reminder status stable', async () => {
    const reminderId = 'reminder-1';

    prisma.appointmentReminder.updateMany.mockResolvedValue({ count: 0 });

    await processor['processOne'](reminderId);

    expect(prisma.appointmentReminder.findUnique).not.toHaveBeenCalled();
    expect(emailService.sendAppointmentReminder).not.toHaveBeenCalled();
  });

  it('keeps a failed reminder eligible for retry without inventing unsupported retry metadata', async () => {
    const reminderId = 'reminder-1';
    const startAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const reminderTime = new Date(startAt.getTime() - 60 * 60 * 1000);

    prisma.appointmentReminder.findMany.mockResolvedValue([
      {
        id: reminderId,
        appointmentId: 'appointment-1',
        kind: AppointmentReminderKind.ONE_HOUR,
        status: AppointmentReminderStatus.PENDING,
        scheduledAt: reminderTime,
      },
    ]);

    prisma.appointmentReminder.updateMany.mockResolvedValue({ count: 1 });

    prisma.appointmentReminder.findUnique.mockResolvedValueOnce({
      id: reminderId,
      appointmentId: 'appointment-1',
      kind: AppointmentReminderKind.ONE_HOUR,
      status: AppointmentReminderStatus.PROCESSING,
      scheduledAt: reminderTime,
      sentAt: null,
    });

    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      status: AppointmentStatus.SCHEDULED,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
      patient: {
        fullName: 'Jane Doe',
        user: { email: 'jane@example.com' },
      },
      doctor: { fullName: 'Dr. Smith' },
    });

    emailService.sendAppointmentReminder.mockResolvedValue(false);

    await processor.processDueReminders();

    expect(emailService.sendAppointmentReminder).toHaveBeenCalledTimes(1);

    expect(prisma.appointmentReminder.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: reminderId,
          status: AppointmentReminderStatus.PROCESSING,
        }),
        data: expect.objectContaining({
          status: AppointmentReminderStatus.PENDING,
        }),
      }),
    );
  });

  it('resets a thrown reminder email failure back to pending for retry', async () => {
    const reminderId = 'reminder-1';
    const startAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const reminderTime = new Date(startAt.getTime() - 60 * 60 * 1000);

    prisma.appointmentReminder.findMany.mockResolvedValue([
      {
        id: reminderId,
        appointmentId: 'appointment-1',
        kind: AppointmentReminderKind.ONE_HOUR,
        status: AppointmentReminderStatus.PENDING,
        scheduledAt: reminderTime,
      },
    ]);

    prisma.appointmentReminder.updateMany.mockResolvedValue({ count: 1 });

    prisma.appointmentReminder.findUnique.mockResolvedValueOnce({
      id: reminderId,
      appointmentId: 'appointment-1',
      kind: AppointmentReminderKind.ONE_HOUR,
      status: AppointmentReminderStatus.PROCESSING,
      scheduledAt: reminderTime,
      sentAt: null,
    });

    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      status: AppointmentStatus.SCHEDULED,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
      patient: {
        fullName: 'Jane Doe',
        user: { email: 'jane@example.com' },
      },
      doctor: { fullName: 'Dr. Smith' },
    });

    emailService.sendAppointmentReminder.mockRejectedValueOnce(
      new Error('SMTP outage'),
    );

    await processor.processDueReminders();

    expect(emailService.sendAppointmentReminder).toHaveBeenCalledTimes(1);

    expect(prisma.appointmentReminder.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: reminderId,
          status: AppointmentReminderStatus.PROCESSING,
        }),
        data: expect.objectContaining({
          status: AppointmentReminderStatus.PENDING,
        }),
      }),
    );
  });

  it('continues processing other reminders even if one reminder fails', async () => {
    const firstReminder = {
      id: 'reminder-1',
      appointmentId: 'first-appointment',
      kind: AppointmentReminderKind.ONE_HOUR,
      status: AppointmentReminderStatus.PENDING,
      scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000 - 60 * 60 * 1000),
      sentAt: null,
    };

    const secondReminder = {
      id: 'reminder-2',
      appointmentId: 'second-appointment',
      kind: AppointmentReminderKind.TWENTY_FOUR_HOURS,
      status: AppointmentReminderStatus.PENDING,
      scheduledAt: new Date(Date.now() + 25 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000),
      sentAt: null,
    };

    prisma.appointmentReminder.findMany.mockResolvedValue([
      firstReminder,
      secondReminder,
    ]);

    prisma.appointmentReminder.updateMany.mockResolvedValue({ count: 1 });

    prisma.appointmentReminder.findUnique
      .mockResolvedValueOnce({
        ...firstReminder,
        status: AppointmentReminderStatus.PROCESSING,
      })
      .mockResolvedValueOnce({
        ...secondReminder,
        status: AppointmentReminderStatus.PROCESSING,
      });

    const firstStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const secondStart = new Date(Date.now() + 25 * 60 * 60 * 1000);

    prisma.appointment.findUnique
      .mockResolvedValueOnce({
        id: 'first-appointment',
        status: AppointmentStatus.SCHEDULED,
        startAt: firstStart,
        endAt: new Date(firstStart.getTime() + 30 * 60 * 1000),
        patient: {
          fullName: 'Patient A',
          user: { email: 'a@example.com' },
        },
        doctor: { fullName: 'Doctor A' },
      })
      .mockResolvedValueOnce({
        id: 'second-appointment',
        status: AppointmentStatus.SCHEDULED,
        startAt: secondStart,
        endAt: new Date(secondStart.getTime() + 30 * 60 * 1000),
        patient: {
          fullName: 'Patient B',
          user: { email: 'b@example.com' },
        },
        doctor: { fullName: 'Doctor B' },
      });

    emailService.sendAppointmentReminder
      .mockRejectedValueOnce(new Error('SMTP outage'))
      .mockResolvedValueOnce(true);

    await processor.processDueReminders();

    expect(emailService.sendAppointmentReminder).toHaveBeenCalledTimes(2);
    expect(prisma.appointmentReminder.updateMany).toHaveBeenCalledTimes(4);
  });

  it('skips scheduling for reminders in the past and cancels reminders for cancelled or completed appointments', async () => {
    const pastStart = new Date(Date.now() - 2 * 60 * 60 * 1000);

    prisma.appointment.findUnique.mockResolvedValue({
      id: 'appointment-1',
      status: AppointmentStatus.CANCELLED,
      startAt: pastStart,
    });

    prisma.appointmentReminder.updateMany.mockResolvedValue({ count: 1 });

    await processor.scheduleForAppointment('appointment-1');

    expect(prisma.appointmentReminder.create).not.toHaveBeenCalled();

    expect(prisma.appointmentReminder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appointmentId: 'appointment-1',
        }),
        data: expect.objectContaining({
          status: AppointmentReminderStatus.CANCELLED,
        }),
      }),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppointmentStatus,
  EmailOutboxEvent,
  EmailOutboxStatus,
} from '../generated/prisma/client.js';
import { EmailOutboxProcessor } from './email-outbox.processor.js';

describe('EmailOutboxProcessor', () => {
  const findMany = vi.fn();
  const findUnique = vi.fn();
  const updateMany = vi.fn();
  const appointmentFindUnique = vi.fn();

  const prisma = {
    emailOutbox: {
      findMany,
      findUnique,
      updateMany,
    },
    appointment: {
      findUnique: appointmentFindUnique,
    },
  };

  const emailService = {
    sendAppointmentBooked: vi.fn(),
    sendAppointmentCancelled: vi.fn(),
  };

  let processor: EmailOutboxProcessor;

  const job = {
    id: 'email-job-1',
    appointmentId: 'appointment-1',
    event: EmailOutboxEvent.BOOKED,
    recipientEmail: 'patient@example.com',
    recipientName: 'Test Patient',
    patientName: 'Test Patient',
    doctorName: 'Test Doctor',
    startAt: new Date('2026-11-01T10:00:00.000Z'),
    endAt: new Date('2026-11-01T10:30:00.000Z'),
    status: EmailOutboxStatus.PROCESSING,
    attempts: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue(job);
    updateMany.mockResolvedValue({ count: 1 });
    appointmentFindUnique.mockResolvedValue({
      status: AppointmentStatus.CONFIRMED,
    });
    emailService.sendAppointmentBooked.mockResolvedValue(true);
    emailService.sendAppointmentCancelled.mockResolvedValue(true);

    processor = new EmailOutboxProcessor(
      prisma as never,
      emailService as never,
    );
  });

  function setupDueJob() {
    findMany.mockResolvedValue([{ id: job.id }]);
  }

  function expectClaim() {
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: job.id,
          status: EmailOutboxStatus.PENDING,
        }),
        data: expect.objectContaining({
          status: EmailOutboxStatus.PROCESSING,
          attempts: { increment: 1 },
        }),
      }),
    );
  }

  it('sends a due booking email and marks the job SENT', async () => {
    setupDueJob();

    await processor.processDueEmails();

    expectClaim();
    expect(emailService.sendAppointmentBooked).toHaveBeenCalledWith(
      job.recipientEmail,
      expect.objectContaining({
        recipientName: job.recipientName,
        patientName: job.patientName,
        doctorName: job.doctorName,
      }),
    );

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: job.id,
          status: EmailOutboxStatus.PROCESSING,
        },
        data: expect.objectContaining({
          status: EmailOutboxStatus.SENT,
          sentAt: expect.any(Date),
          lastError: null,
        }),
      }),
    );
  });

  it('does not send a booking email if the appointment is cancelled', async () => {
    setupDueJob();
    appointmentFindUnique.mockResolvedValue({
      status: AppointmentStatus.CANCELLED,
    });

    await processor.processDueEmails();

    expect(emailService.sendAppointmentBooked).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: job.id,
          status: EmailOutboxStatus.PROCESSING,
        },
        data: {
          status: EmailOutboxStatus.CANCELLED,
          lastError: null,
        },
      }),
    );
  });

  it('still sends a cancellation email for a cancelled appointment', async () => {
    setupDueJob();
    findUnique.mockResolvedValue({
      ...job,
      event: EmailOutboxEvent.CANCELLED,
    });
    appointmentFindUnique.mockResolvedValue({
      status: AppointmentStatus.CANCELLED,
    });

    await processor.processDueEmails();

    expect(emailService.sendAppointmentCancelled).toHaveBeenCalled();
    expect(emailService.sendAppointmentBooked).not.toHaveBeenCalled();
    expect(appointmentFindUnique).not.toHaveBeenCalled();
  });

  it('schedules a retry when email delivery returns false', async () => {
    setupDueJob();
    emailService.sendAppointmentBooked.mockResolvedValue(false);

    await processor.processDueEmails();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: job.id,
          status: EmailOutboxStatus.PROCESSING,
        },
        data: expect.objectContaining({
          status: EmailOutboxStatus.PENDING,
          nextAttemptAt: expect.any(Date),
          lastError: 'EmailDeliveryFailed',
        }),
      }),
    );
  });

  it('marks the job FAILED after the fifth failed attempt', async () => {
    setupDueJob();
    findUnique.mockResolvedValue({
      ...job,
      attempts: 5,
    });
    emailService.sendAppointmentBooked.mockResolvedValue(false);

    await processor.processDueEmails();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: job.id,
          status: EmailOutboxStatus.PROCESSING,
        },
        data: {
          status: EmailOutboxStatus.FAILED,
          lastError: 'EmailDeliveryFailed',
        },
      }),
    );
  });

  it('does not send if another worker already claimed the job', async () => {
    setupDueJob();
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 0 });

    await processor.processDueEmails();

    expectClaim();
    expect(findUnique).not.toHaveBeenCalled();
    expect(emailService.sendAppointmentBooked).not.toHaveBeenCalled();
  });

  it('recovers stale PROCESSING jobs', async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await processor.processDueEmails();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: EmailOutboxStatus.PROCESSING,
          updatedAt: { lt: expect.any(Date) },
        }),
        data: expect.objectContaining({
          status: EmailOutboxStatus.PENDING,
          nextAttemptAt: expect.any(Date),
          lastError: 'Recovered stale processing job',
        }),
      }),
    );
  });
});

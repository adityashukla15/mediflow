import { describe, it, expect, beforeEach, vi } from 'vitest';

import { EmailOutboxEvent } from '../generated/prisma/client.js';
import {
  EmailOutboxService,
  type EnqueueAppointmentEmailsInput,
} from './email-outbox.service.js';

describe('EmailOutboxService', () => {
  const upsert = vi.fn();
  const prisma = {
    emailOutbox: { upsert },
  };

  let service: EmailOutboxService;

  const input: EnqueueAppointmentEmailsInput = {
    appointmentId: 'appointment-1',
    event: EmailOutboxEvent.BOOKED,
    patientEmail: 'patient@example.com',
    patientName: 'Test Patient',
    doctorEmail: 'doctor@example.com',
    doctorName: 'Test Doctor',
    startAt: new Date('2026-11-01T10:00:00.000Z'),
    endAt: new Date('2026-11-01T10:30:00.000Z'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    upsert.mockResolvedValue({});
    service = new EmailOutboxService(prisma as never);
  });

  it('enqueues one job for the patient and one for the doctor', async () => {
    await service.enqueueAppointmentEmails(input);

    expect(upsert).toHaveBeenCalledTimes(2);

    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          idempotencyKey: 'appointment-1:BOOKED:PATIENT',
        },
        create: expect.objectContaining({
          appointmentId: 'appointment-1',
          event: EmailOutboxEvent.BOOKED,
          recipientEmail: 'patient@example.com',
          recipientName: 'Test Patient',
        }),
        update: {},
      }),
    );

    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          idempotencyKey: 'appointment-1:BOOKED:DOCTOR',
        },
        create: expect.objectContaining({
          recipientEmail: 'doctor@example.com',
          recipientName: 'Test Doctor',
        }),
        update: {},
      }),
    );
  });

  it('uses the same idempotency keys when the same event is enqueued again', async () => {
    await service.enqueueAppointmentEmails(input);
    await service.enqueueAppointmentEmails(input);

    expect(upsert).toHaveBeenCalledTimes(4);

    const keys = upsert.mock.calls.map(
      ([args]) => args.where.idempotencyKey,
    );

    expect(keys).toEqual([
      'appointment-1:BOOKED:PATIENT',
      'appointment-1:BOOKED:DOCTOR',
      'appointment-1:BOOKED:PATIENT',
      'appointment-1:BOOKED:DOCTOR',
    ]);

    for (const [args] of upsert.mock.calls) {
      expect(args.update).toEqual({});
    }
  });

  it('skips recipients with blank email addresses or names', async () => {
    await service.enqueueAppointmentEmails({
      ...input,
      patientEmail: '   ',
      doctorName: '   ',
    });

    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not silently swallow database enqueue failures', async () => {
    upsert.mockRejectedValueOnce(new Error('Database unavailable'));

    await expect(
      service.enqueueAppointmentEmails(input),
    ).rejects.toThrow('Database unavailable');
  });
});

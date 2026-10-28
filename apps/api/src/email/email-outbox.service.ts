
import { Injectable, Logger } from '@nestjs/common';
import { EmailOutboxEvent } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface EnqueueAppointmentEmailsInput {
  appointmentId: string;
  event: EmailOutboxEvent;
  patientEmail: string;
  patientName: string;
  doctorEmail: string;
  doctorName: string;
  startAt: Date;
  endAt: Date;
}

@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  async enqueueAppointmentEmails(
    input: EnqueueAppointmentEmailsInput,
  ): Promise<void> {
    const recipients = [
      {
        kind: 'PATIENT',
        email: input.patientEmail,
        name: input.patientName,
      },
      {
        kind: 'DOCTOR',
        email: input.doctorEmail,
        name: input.doctorName,
      },
    ].filter(
      (recipient) =>
        recipient.email.trim().length > 0 &&
        recipient.name.trim().length > 0,
    );

    for (const recipient of recipients) {
      const idempotencyKey =
        `${input.appointmentId}:${input.event}:${recipient.kind}`;

      await this.prisma.emailOutbox.upsert({
        where: { idempotencyKey },
        create: {
          idempotencyKey,
          appointmentId: input.appointmentId,
          event: input.event,
          recipientEmail: recipient.email,
          recipientName: recipient.name,
          patientName: input.patientName,
          doctorName: input.doctorName,
          startAt: input.startAt,
          endAt: input.endAt,
        },
        // A duplicate enqueue must not reset a sent job or its retry state.
        update: {},
      });
    }

    this.logger.log(
      `Queued ${recipients.length} appointment email job(s) for event ${input.event}.`,
    );
  }
}

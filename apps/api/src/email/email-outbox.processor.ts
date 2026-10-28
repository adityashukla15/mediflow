
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  AppointmentStatus,
  EmailOutboxEvent,
  EmailOutboxStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from './email.service.js';

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;
const STALE_PROCESSING_MINUTES = 5;

@Injectable()
export class EmailOutboxProcessor {
  private readonly logger = new Logger(EmailOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processDueEmails(): Promise<void> {
    const now = new Date();

    try {
      await this.recoverStaleJobs(now);

      const jobs = await this.prisma.emailOutbox.findMany({
        where: {
          status: EmailOutboxStatus.PENDING,
          nextAttemptAt: { lte: now },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true },
      });

      for (const job of jobs) {
        try {
          await this.processOne(job.id);
        } catch {
          // Avoid logging email addresses or other potentially sensitive data.
          this.logger.error(`Failed to process email job ${job.id}.`);
        }
      }
    } catch {
      this.logger.error('Email outbox polling failed.');
    }
  }

  private async processOne(id: string): Promise<void> {
    const now = new Date();

    // Atomic claim: only one worker can claim a PENDING job.
    const claim = await this.prisma.emailOutbox.updateMany({
      where: {
        id,
        status: EmailOutboxStatus.PENDING,
        nextAttemptAt: { lte: now },
      },
      data: {
        status: EmailOutboxStatus.PROCESSING,
        attempts: { increment: 1 },
      },
    });

    if (claim.count !== 1) {
      return;
    }

    const job = await this.prisma.emailOutbox.findUnique({
      where: { id },
    });

    if (!job || job.status !== EmailOutboxStatus.PROCESSING) {
      return;
    }

    try {
      // A booking email is no longer useful if the appointment was cancelled.
      // Cancellation emails must still be delivered for cancelled appointments.
      if (job.event === EmailOutboxEvent.BOOKED) {
        const appointment = await this.prisma.appointment.findUnique({
          where: { id: job.appointmentId },
          select: { status: true },
        });

        if (
          !appointment ||
          appointment.status === AppointmentStatus.CANCELLED
        ) {
          await this.prisma.emailOutbox.updateMany({
            where: {
              id,
              status: EmailOutboxStatus.PROCESSING,
            },
            data: {
              status: EmailOutboxStatus.CANCELLED,
              lastError: null,
            },
          });

          return;
        }
      }

      const details = {
        recipientName: job.recipientName,
        patientName: job.patientName,
        doctorName: job.doctorName,
        startAt: job.startAt,
        endAt: job.endAt,
      };

      const sent =
        job.event === EmailOutboxEvent.BOOKED
          ? await this.emailService.sendAppointmentBooked(
              job.recipientEmail,
              details,
            )
          : await this.emailService.sendAppointmentCancelled(
              job.recipientEmail,
              details,
            );

      if (sent) {
        await this.prisma.emailOutbox.updateMany({
          where: {
            id,
            status: EmailOutboxStatus.PROCESSING,
          },
          data: {
            status: EmailOutboxStatus.SENT,
            sentAt: new Date(),
            lastError: null,
          },
        });

        return;
      }

      await this.recordFailure(id, job.attempts);
    } catch (error) {
      // Store only the error class, not raw SMTP messages that might contain
      // recipient addresses or other sensitive information.
      const errorType =
        error instanceof Error ? error.name : 'UnknownError';

      await this.recordFailure(id, job.attempts, errorType);
    }
  }

  private async recordFailure(
    id: string,
    attempts: number,
    errorType = 'EmailDeliveryFailed',
  ): Promise<void> {
    if (attempts >= MAX_ATTEMPTS) {
      await this.prisma.emailOutbox.updateMany({
        where: {
          id,
          status: EmailOutboxStatus.PROCESSING,
        },
        data: {
          status: EmailOutboxStatus.FAILED,
          lastError: errorType.slice(0, 500),
        },
      });

      this.logger.warn(`Email job ${id} reached its retry limit.`);
      return;
    }

    // Attempts 1–4: retry after 1, 2, 4, and 8 minutes.
    const delayMinutes = 2 ** (attempts - 1);
    const nextAttemptAt = new Date(
      Date.now() + delayMinutes * 60 * 1000,
    );

    await this.prisma.emailOutbox.updateMany({
      where: {
        id,
        status: EmailOutboxStatus.PROCESSING,
      },
      data: {
        status: EmailOutboxStatus.PENDING,
        nextAttemptAt,
        lastError: errorType.slice(0, 500),
      },
    });
  }

  private async recoverStaleJobs(now: Date): Promise<void> {
    const staleBefore = new Date(
      now.getTime() - STALE_PROCESSING_MINUTES * 60 * 1000,
    );

    const result = await this.prisma.emailOutbox.updateMany({
      where: {
        status: EmailOutboxStatus.PROCESSING,
        updatedAt: { lt: staleBefore },
      },
      data: {
        status: EmailOutboxStatus.PENDING,
        nextAttemptAt: now,
        lastError: 'Recovered stale processing job',
      },
    });

    if (result.count > 0) {
      this.logger.warn(`Recovered ${result.count} stale email job(s).`);
    }
  }
}

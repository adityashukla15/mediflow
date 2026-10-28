import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  AppointmentReminderKind,
  AppointmentReminderStatus,
  AppointmentStatus,
} from '../generated/prisma/client.js';
import { EmailService } from '../email/email.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class AppointmentRemindersProcessor {
  private readonly logger = new Logger(
    AppointmentRemindersProcessor.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async scheduleForAppointment(appointmentId: string): Promise<void> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        startAt: true,
      },
    });

    if (!appointment) {
      return;
    }

    if (
      appointment.status === AppointmentStatus.CANCELLED ||
      appointment.status === AppointmentStatus.COMPLETED ||
      appointment.status === AppointmentStatus.NO_SHOW
    ) {
      await this.cancelForAppointment(appointmentId);
      return;
    }

    for (const kind of this.reminderKinds()) {
      const scheduledAt = this.getScheduledAt(appointment.startAt, kind);
      if (scheduledAt <= new Date()) {
        continue;
      }

      await this.upsertReminder(appointmentId, kind, scheduledAt);
    }
  }

  async cancelForAppointment(appointmentId: string): Promise<void> {
    await this.prisma.appointmentReminder.updateMany({
      where: {
        appointmentId,
        status: {
          in: [
            AppointmentReminderStatus.PENDING,
            AppointmentReminderStatus.PROCESSING,
          ],
        },
      },
      data: {
        status: AppointmentReminderStatus.CANCELLED,
      },
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processDueReminders(): Promise<void> {
    const now = new Date();

    const reminders = await this.prisma.appointmentReminder.findMany({
      where: {
        status: AppointmentReminderStatus.PENDING,
        scheduledAt: { lte: now },
      },
      orderBy: { scheduledAt: 'asc' },
      take: 50,
    });

    for (const reminder of reminders) {
      try {
        await this.processOne(reminder.id);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'Unknown error';

        this.logger.error(
          `Failed to process reminder ${reminder.id}: ${reason}`,
        );
      }
    }
  }

  private async processOne(reminderId: string): Promise<void> {
    const claim = await this.prisma.appointmentReminder.updateMany({
      where: {
        id: reminderId,
        status: AppointmentReminderStatus.PENDING,
      },
      data: {
        status: AppointmentReminderStatus.PROCESSING,
      },
    });

    if (claim.count !== 1) {
      return;
    }

    const reminder = await this.prisma.appointmentReminder.findUnique({
      where: { id: reminderId },
    });
if (
  !reminder ||
  reminder.status !== AppointmentReminderStatus.PROCESSING
) {
  return;
}

    try {
      const appointment = await this.prisma.appointment.findUnique({
        where: { id: reminder.appointmentId },
        include: {
          patient: {
            select: {
              fullName: true,
              user: {
                select: { email: true },
              },
            },
          },
          doctor: {
            select: {
              fullName: true,
            },
          },
        },
      });

      const now = new Date();
      const isActive =
        appointment &&
        (appointment.status === AppointmentStatus.SCHEDULED ||
          appointment.status === AppointmentStatus.CONFIRMED);
      const expectedTime = this.getScheduledAt(
        appointment?.startAt ?? new Date(),
        reminder.kind,
      );
      const sameSchedule =
        !!appointment &&
        Math.abs(reminder.scheduledAt.getTime() - expectedTime.getTime()) < 1000;

      if (!appointment || !isActive || !sameSchedule || appointment.startAt <= now) {
        await this.prisma.appointmentReminder.updateMany({
          where: {
            id: reminder.id,
            status: AppointmentReminderStatus.PROCESSING,
          },
          data: {
            status: AppointmentReminderStatus.CANCELLED,
          },
        });
        return;
      }

      const sent = await this.emailService.sendAppointmentReminder(
        appointment.patient.user.email,
        {
          recipientName: appointment.patient.fullName,
          patientName: appointment.patient.fullName,
          doctorName: appointment.doctor.fullName,
          startAt: appointment.startAt,
          endAt: appointment.endAt,
        },
        reminder.kind,
      );

      if (sent) {
        await this.prisma.appointmentReminder.updateMany({
          where: {
            id: reminder.id,
            status: AppointmentReminderStatus.PROCESSING,
          },
          data: {
            status: AppointmentReminderStatus.SENT,
            sentAt: new Date(),
          },
        });
        return;
      }

      await this.prisma.appointmentReminder.updateMany({
        where: {
          id: reminder.id,
          status: AppointmentReminderStatus.PROCESSING,
        },
        data: {
          status: AppointmentReminderStatus.PENDING,
        },
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(
        `Reminder processing failed for ${reminderId}: ${reason}`,
      );

      await this.prisma.appointmentReminder.updateMany({
        where: {
          id: reminderId,
          status: AppointmentReminderStatus.PROCESSING,
        },
        data: {
          status: AppointmentReminderStatus.PENDING,
        },
      });
    }
  }

  private reminderKinds(): AppointmentReminderKind[] {
    return [
      AppointmentReminderKind.TWENTY_FOUR_HOURS,
      AppointmentReminderKind.ONE_HOUR,
    ];
  }

  private getScheduledAt(
    startAt: Date,
    kind: AppointmentReminderKind,
  ): Date {
    const offsetMs =
      kind === AppointmentReminderKind.TWENTY_FOUR_HOURS
        ? 24 * 60 * 60 * 1000
        : 60 * 60 * 1000;

    return new Date(startAt.getTime() - offsetMs);
  }

  private async upsertReminder(
    appointmentId: string,
    kind: AppointmentReminderKind,
    scheduledAt: Date,
  ): Promise<void> {
    const existing = await this.prisma.appointmentReminder.findUnique({
      where: {
        appointmentId_kind: {
          appointmentId,
          kind,
        },
      },
    });

    if (!existing) {
      await this.prisma.appointmentReminder.create({
        data: {
          appointmentId,
          kind,
          status: AppointmentReminderStatus.PENDING,
          scheduledAt,
        },
      });
      return;
    }

    if (existing.status === AppointmentReminderStatus.SENT) {
      return;
    }

    if (existing.status === AppointmentReminderStatus.PROCESSING) {
      return;
    }

    await this.prisma.appointmentReminder.update({
      where: { id: existing.id },
      data: {
        scheduledAt,
        status: AppointmentReminderStatus.PENDING,
        sentAt: null,
      },
    });
  }
}
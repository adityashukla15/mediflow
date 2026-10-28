
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

import {
  appointmentBookedTemplate,
  appointmentCancelledTemplate,
  appointmentReminderTemplate,
  type AppointmentEmailDetails,
  type AppointmentReminderKind,
} from './templates/appointment.templates.js';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string | null;

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST');
    const user = config.get<string>('SMTP_USER');
    const password = config.get<string>('SMTP_PASSWORD');
    const from = config.get<string>('EMAIL_FROM');
    const port = Number(config.get<string>('SMTP_PORT') ?? 587);
    const secure =
      config.get<string>('SMTP_SECURE')?.toLowerCase() === 'true';

    if (!host || !user || !password || !from) {
      this.logger.warn(
        'SMTP is not fully configured. Appointment emails are disabled.',
      );
      this.transporter = null;
      this.from = null;
      return;
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.logger.warn('Invalid SMTP_PORT. Appointment emails are disabled.');
      this.transporter = null;
      this.from = null;
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass: password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });

    this.from = from;
  }

  async sendAppointmentBooked(
  to: string,
  details: AppointmentEmailDetails,
): Promise<boolean> {
  return this.sendTemplate(to, appointmentBookedTemplate(details));
}

async sendAppointmentCancelled(
  to: string,
  details: AppointmentEmailDetails,
): Promise<boolean> {
  return this.sendTemplate(to, appointmentCancelledTemplate(details));
}

  async sendAppointmentReminder(
    to: string,
    details: AppointmentEmailDetails,
    kind: AppointmentReminderKind,
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      appointmentReminderTemplate(details, kind),
    );
  }

  private async sendTemplate(
    to: string,
    template: { subject: string; html: string; text: string },
  ): Promise<boolean> {
    if (!this.transporter || !this.from) {
      this.logger.warn('Email skipped because SMTP is not configured.');
      return false;
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject: template.subject,
        text: template.text,
        html: template.html,
      });

      return true;
    } catch (error) {
      // Never log recipient addresses, email contents, or SMTP credentials.
      const reason =
        error instanceof Error ? error.message : 'Unknown SMTP error';

      this.logger.error(`Appointment email delivery failed: ${reason}`);
      return false;
    }
  }
}

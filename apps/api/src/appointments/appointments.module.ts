
import { Module } from '@nestjs/common';

import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { EmailModule } from '../email/email.module.js';
import { AppointmentRemindersModule } from '../appointment-reminders/appointment-reminders.module.js';

@Module({
  imports: [NotificationsModule, EmailModule, AppointmentRemindersModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
})
export class AppointmentsModule {}

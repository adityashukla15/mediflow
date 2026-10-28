import { Module } from '@nestjs/common';

import { EmailModule } from '../email/email.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AppointmentRemindersProcessor } from './appointment-reminders.processor.js';

@Module({
  imports: [PrismaModule, EmailModule],
  providers: [AppointmentRemindersProcessor],
  exports: [AppointmentRemindersProcessor],
})
export class AppointmentRemindersModule {}
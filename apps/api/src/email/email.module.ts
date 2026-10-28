
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { EmailOutboxProcessor } from './email-outbox.processor.js';
import { EmailOutboxService } from './email-outbox.service.js';
import { EmailService } from './email.service.js';

@Module({
  imports: [PrismaModule],
  providers: [
    EmailService,
    EmailOutboxService,
    EmailOutboxProcessor,
  ],
  exports: [EmailService, EmailOutboxService],
})
export class EmailModule {}

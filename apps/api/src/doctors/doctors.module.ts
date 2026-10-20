
import { Module } from '@nestjs/common';

import { RolesGuard } from '../auth/guards/roles.gaurd.js';
import { DoctorsController } from './doctors.controller.js';
import { DoctorsService } from './doctors.service.js';

@Module({
  controllers: [DoctorsController],
  providers: [DoctorsService, RolesGuard],
})
export class DoctorsModule {}

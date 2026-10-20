
import { Module } from '@nestjs/common';

import { RolesGuard } from '../auth/guards/roles.gaurd.js';
import { DepartmentsController } from './departments.controller.js';
import { DepartmentsService } from './departments.service.js';

@Module({
  controllers: [DepartmentsController],
  providers: [DepartmentsService, RolesGuard],
})
export class DepartmentsModule {}

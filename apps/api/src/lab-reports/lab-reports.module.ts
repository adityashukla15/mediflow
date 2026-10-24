
import { Module } from '@nestjs/common';

import { LabReportsController } from './lab-reports.controller.js';
import { LabReportsService } from './lab-reports.service.js';

@Module({
  controllers: [LabReportsController],
  providers: [LabReportsService],
})
export class LabReportsModule {}

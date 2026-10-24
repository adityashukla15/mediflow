
import { Module } from '@nestjs/common';

import { PatientsController } from './patients.controller.js';
import { PatientsService } from './patients.service.js';
import { MedicalRecordsModule } from '../medical-records/medical-records.module.js';


@Module({
  imports: [MedicalRecordsModule],
  controllers: [PatientsController],
  providers: [PatientsService],
})
export class PatientsModule {}

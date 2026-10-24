
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategies.js';

import { UpdatePatientProfileDto } from './dto/update-patient-profile.dto.js';
import { PatientsService } from './patients.service.js';

import { MedicalRecordsService } from '../medical-records/medical-records.service.js';
import { ListMedicalRecordsQueryDto } from '../medical-records/dto/list-medical-records-query.dto.js';

@Controller('patients')
@UseGuards(JwtAuthGuard)
export class PatientsController {
  constructor(
    private readonly patientsService: PatientsService,
    private readonly medicalRecordsService: MedicalRecordsService,
  ) {}

  @Get('me')
  getMyProfile(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patientsService.getMyProfile(user.id);
  }

  @Put('me')
  updateMyProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePatientProfileDto,
  ) {
    return this.patientsService.updateMyProfile(
      user.id,
      dto,
    );
  }

  @Get(':patientId/medical-records')
  getPatientMedicalRecords(
    @CurrentUser() user: AuthenticatedUser,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Query() query: ListMedicalRecordsQueryDto,
  ) {
    return this.medicalRecordsService.findForPatient(
      user,
      patientId,
      query,
    );
  }
}

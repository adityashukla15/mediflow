
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.gaurd.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorators.js';
import { UserRole } from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategies.js';

import { MedicalRecordsService } from './medical-records.service.js';
import { CreateMedicalRecordDto } from './dto/create-medical-record.dto.js';
import { ListMedicalRecordsQueryDto } from './dto/list-medical-records-query.dto.js';

@Controller('medical-records')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MedicalRecordsController {
  constructor(
    private readonly medicalRecordsService: MedicalRecordsService,
  ) {}

  @Post()
  @Roles(UserRole.DOCTOR)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMedicalRecordDto,
  ) {
    return this.medicalRecordsService.create(user, dto);
  }

  @Get()
  @Roles(UserRole.PATIENT, UserRole.DOCTOR)
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListMedicalRecordsQueryDto,
  ) {
    return this.medicalRecordsService.findAll(user, query);
  }

  @Get(':id')
  @Roles(UserRole.PATIENT, UserRole.DOCTOR)
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.medicalRecordsService.findOne(user, id);
  }
}

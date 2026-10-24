
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { UserRole } from '../generated/prisma/client.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorators.js';
import { RolesGuard } from '../auth/guards/roles.gaurd.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategies.js';

import { CreateLabReportDto } from './dto/create-lab-report.dto.js';
import { UpdateLabReportDto } from './dto/update-lab-report.dto.js';
import { LabReportsService } from './lab-reports.service.js';

@Controller('lab-reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LabReportsController {
  constructor(private readonly labReportsService: LabReportsService) {}

  @Post()
  @Roles(UserRole.DOCTOR)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLabReportDto,
  ) {
    return this.labReportsService.create(user, dto);
  }

  @Get()
  @Roles(UserRole.PATIENT, UserRole.DOCTOR)
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.labReportsService.findAll(user);
  }

  @Get(':id')
  @Roles(UserRole.PATIENT, UserRole.DOCTOR)
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.labReportsService.findOne(user, id);
  }

  @Patch(':id')
  @Roles(UserRole.DOCTOR)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateLabReportDto,
  ) {
    return this.labReportsService.update(user, id, dto);
  }
}

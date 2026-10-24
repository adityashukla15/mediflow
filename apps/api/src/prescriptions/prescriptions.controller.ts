
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

import { CreatePrescriptionDto } from './dto/create-prescription.dto.js';
import { UpdatePrescriptionDto } from './dto/update-prescription.dto.js';
import { PrescriptionsService } from './prescriptions.service.js';

@Controller('prescriptions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PrescriptionsController {
  constructor(private readonly prescriptionsService: PrescriptionsService) {}

  @Post()
  @Roles(UserRole.DOCTOR)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePrescriptionDto,
  ) {
    return this.prescriptionsService.create(user, dto);
  }

  @Get()
  @Roles(UserRole.PATIENT, UserRole.DOCTOR)
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.prescriptionsService.findAll(user);
  }

  @Get(':id')
  @Roles(UserRole.PATIENT, UserRole.DOCTOR)
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.prescriptionsService.findOne(user, id);
  }

  @Patch(':id')
  @Roles(UserRole.DOCTOR)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePrescriptionDto,
  ) {
    return this.prescriptionsService.update(user, id, dto);
  }

  @Post(':id/cancel')
  @Roles(UserRole.DOCTOR)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.prescriptionsService.cancel(user, id);
  }
}

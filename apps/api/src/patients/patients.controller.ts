
import {
  Body,
  Controller,
  Get,
  Put,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategies.js';

import { UpdatePatientProfileDto } from './dto/update-patient-profile.dto.js';
import { PatientsService } from './patients.service.js';

@Controller('patients')
@UseGuards(JwtAuthGuard)
export class PatientsController {
  constructor(
    private readonly patientsService: PatientsService,
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
}

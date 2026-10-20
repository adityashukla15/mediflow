
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.gaurd.js';
import { Roles } from '../auth/decorators/roles.decorators.js';
import { UserRole } from '../generated/prisma/client.js';

import { DoctorsService } from './doctors.service.js';
import { CreateDoctorDto } from './dto/create-doctor.dto.js';
import { UpdateDoctorDto } from './dto/update-doctor.dto.js';
import { SetDoctorScheduleDto } from './dto/set-doctor-schedule.dto.js';

@Controller('doctors')
@UseGuards(JwtAuthGuard)
export class DoctorsController {
  constructor(private readonly doctorsService: DoctorsService) {}

  @Get()
  findAll() {
    return this.doctorsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.doctorsService.findOne(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  create(@Body() dto: CreateDoctorDto) {
    return this.doctorsService.create(dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDoctorDto,
  ) {
    return this.doctorsService.update(id, dto);
  }

  @Put(':id/schedules')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  setSchedule(
    @Param('id') id: string,
    @Body() dto: SetDoctorScheduleDto,
  ) {
    return this.doctorsService.setSchedule(id, dto);
  }
}

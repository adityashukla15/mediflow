
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.gaurd.js';
import { Roles } from '../auth/decorators/roles.decorators.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UserRole } from '../generated/prisma/client.js';

import { DoctorsService } from './doctors.service.js';
import { CreateDoctorDto } from './dto/create-doctor.dto.js';
import { UpdateDoctorDto } from './dto/update-doctor.dto.js';
import { SetDoctorScheduleDto } from './dto/set-doctor-schedule.dto.js';

@Controller('doctors')
@UseGuards(JwtAuthGuard)
export class DoctorsController {
  constructor(
    private readonly doctorsService: DoctorsService,
  ) {}

  // Get all doctors
  @Get()
  findAll() {
    return this.doctorsService.findAll();
  }

  // Get logged-in doctor's appointments
  @Get('me/appointments')
  @UseGuards(RolesGuard)
  @Roles(UserRole.DOCTOR)
  findMyAppointments(
    @CurrentUser() user: { id: string; role: UserRole },
  ) {
    return this.doctorsService.findMyAppointments(user.id);
  }

  // Get doctor availability for a date
  @Get(':id/availability')
  getAvailability(
    @Param('id') id: string,
    @Query('date') date: string,
  ) {
    return this.doctorsService.getAvailability(id, date);
  }

  // Get doctor by ID
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.doctorsService.findOne(id);
  }

  // Create doctor
  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  create(@Body() dto: CreateDoctorDto) {
    return this.doctorsService.create(dto);
  }

  // Update doctor
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDoctorDto,
  ) {
    return this.doctorsService.update(id, dto);
  }

  // Set doctor schedule
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

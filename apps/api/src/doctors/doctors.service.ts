
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  DayOfWeek,
  UserRole,
  UserStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { CreateDoctorDto } from './dto/create-doctor.dto.js';
import { UpdateDoctorDto } from './dto/update-doctor.dto.js';
import { SetDoctorScheduleDto } from './dto/set-doctor-schedule.dto.js';

function getPrismaErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
}

@Injectable()
export class DoctorsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.doctorProfile.findMany({
      where: {
        isActive: true,
        department: {
          is: { isActive: true },
        },
        user: {
          is: {
            role: UserRole.DOCTOR,
            status: UserStatus.ACTIVE,
          },
        },
      },
      orderBy: { fullName: 'asc' },
      include: {
        department: true,
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
          },
        },
        schedules: {
          where: {
            isActive: true
          },
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
        },
      },
    });
  }

  async findOne(id: string) {
    const doctor = await this.prisma.doctorProfile.findFirst({
      where: {
        id,
        isActive: true,
        department: {
          is: { isActive: true },
        },
        user: {
          is: {
            role: UserRole.DOCTOR,
            status: UserStatus.ACTIVE,
          },
        },
      },
      include: {
        department: true,
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
          },
        },
        schedules: {
          where: {
            isActive: true
          },
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
        },
      },
    });

    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }

    return doctor;
  }

  async create(dto: CreateDoctorDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true, role: true, status: true },
    });

    if (!user) {
      throw new NotFoundException('Doctor user account not found');
    }

    if (user.role !== UserRole.DOCTOR) {
      throw new BadRequestException(
        'The linked user account must have the DOCTOR role',
      );
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new BadRequestException(
        'The linked doctor user account is not active',
      );
    }

    const department = await this.prisma.department.findUnique({
      where: { id: dto.departmentId },
      select: { id: true, isActive: true },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    if (!department.isActive) {
      throw new BadRequestException(
        'Cannot assign a doctor to an inactive department',
      );
    }

    try {
      return await this.prisma.doctorProfile.create({
        data: {
          userId: dto.userId,
          departmentId: dto.departmentId,
          fullName: dto.fullName.trim(),
          specialization: dto.specialization.trim(),
          qualification: dto.qualification?.trim(),
          consultationFee: dto.consultationFee,
        },
        include: {
          department: true,
          user: {
            select: {
              id: true,
              email: true,
              role: true,
              status: true,
            },
          },
          schedules: true,
        },
      });
    } catch (error: unknown) {
      const code = getPrismaErrorCode(error);

      if (code === 'P2002') {
        throw new ConflictException(
          'A doctor profile already exists for this user account',
        );
      }

      if (code === 'P2003') {
        throw new BadRequestException(
          'The supplied user or department reference is invalid',
        );
      }

      throw error;
    }
  }

  async update(id: string, dto: UpdateDoctorDto) {
    await this.findOne(id);

    if (dto.departmentId) {
      const department = await this.prisma.department.findUnique({
        where: { id: dto.departmentId },
        select: { id: true, isActive: true },
      });

      if (!department) {
        throw new NotFoundException('Department not found');
      }

      if (!department.isActive) {
        throw new BadRequestException(
          'Cannot assign a doctor to an inactive department',
        );
      }
    }

    try {
      return await this.prisma.doctorProfile.update({
        where: { id },
        data: {
          ...(dto.departmentId !== undefined && {
            departmentId: dto.departmentId,
          }),
          ...(dto.fullName !== undefined && {
            fullName: dto.fullName.trim(),
          }),
          ...(dto.specialization !== undefined && {
            specialization: dto.specialization.trim(),
          }),
          ...(dto.qualification !== undefined && {
            qualification: dto.qualification.trim(),
          }),
          ...(dto.consultationFee !== undefined && {
            consultationFee: dto.consultationFee,
          }),
          ...(dto.isActive !== undefined && {
            isActive: dto.isActive,
          }),
        },
        include: {
          department: true,
          user: {
            select: {
              id: true,
              email: true,
              role: true,
              status: true,
            },
          },
          schedules: true,
        },
      });
    } catch (error: unknown) {
      if (getPrismaErrorCode(error) === 'P2025') {
        throw new NotFoundException('Doctor not found');
      }

      if (getPrismaErrorCode(error) === 'P2003') {
        throw new BadRequestException('Invalid department reference');
      }

      throw error;
    }
  }

  async setSchedule(id: string, dto: SetDoctorScheduleDto) {
    const startMinutes = this.toMinutes(dto.startTime);
    const endMinutes = this.toMinutes(dto.endTime);

    if (startMinutes >= endMinutes) {
      throw new BadRequestException(
        'startTime must be earlier than endTime',
      );
    }

    const doctor = await this.prisma.doctorProfile.findFirst({
      where: {
        id,
        isActive: true,
        department: {
          is: { isActive: true },
        },
        user: {
          is: {
            role: UserRole.DOCTOR,
            status: UserStatus.ACTIVE,
          },
        },
      },
      select: {
        id: true,
        isActive: true,
        user: { select: { status: true } },
        department: { select: { isActive: true } },
      },
    });

    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }

    if (!doctor.isActive) {
      throw new BadRequestException(
        'Cannot set a schedule for an inactive doctor',
      );
    }

    if (doctor.user.status !== UserStatus.ACTIVE) {
      throw new BadRequestException(
        'Cannot set a schedule for an inactive user account',
      );
    }

    if (!doctor.department.isActive) {
      throw new BadRequestException(
        'Cannot set a schedule for a doctor in an inactive department',
      );
    }

    // Scheduling rule: a doctor can have one slot per weekday.
    // Replace that weekday's existing slot atomically.
    return this.prisma.$transaction(async (tx) => {
      await tx.doctorSchedule.deleteMany({
        where: {
          doctorId: id,
          dayOfWeek: dto.dayOfWeek,
        },
      });

      return tx.doctorSchedule.create({
        data: {
          doctorId: id,
          dayOfWeek: dto.dayOfWeek,
          startTime: dto.startTime,
          endTime: dto.endTime,
        },
      });
    });
  }

  private toMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }
}

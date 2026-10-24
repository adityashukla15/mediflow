
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  AppointmentStatus,
  DayOfWeek,
  UserRole,
  UserStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateAppointmentDto } from './dto/create-appointment.dto.js';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto.js';
import { UpdateAppointmentStatusDto } from './dto/update-appointment-status.dto.js';

type AppointmentUser = {
  id: string;
  email: string;
  role: UserRole;
};

const ACTIVE_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
];

@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AppointmentUser, dto: CreateAppointmentDto) {
    if (user.role !== UserRole.PATIENT) {
      throw new ForbiddenException(
        'Only patient accounts can book appointments',
      );
    }

    const { startAt, endAt } = this.validateTimeRange(
      dto.startAt,
      dto.endAt,
    );

    const patient = await this.prisma.patientProfile.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });

    if (!patient) {
      throw new NotFoundException(
        'Patient profile not found. Create your profile first.',
      );
    }

    const doctor = await this.prisma.doctorProfile.findFirst({
      where: {
        id: dto.doctorId,
        isActive: true,
        department: { is: { isActive: true } },
        user: {
          is: {
            role: UserRole.DOCTOR,
            status: UserStatus.ACTIVE,
          },
        },
      },
      select: { id: true },
    });

    if (!doctor) {
      throw new NotFoundException('Active doctor not found');
    }

    await this.validateDoctorSchedule(doctor.id, startAt, endAt);
    await this.ensureNoOverlap(doctor.id, startAt, endAt);

    try {
      return await this.prisma.appointment.create({
        data: {
          patientId: patient.id,
          doctorId: doctor.id,
          startAt,
          endAt,
          reason: dto.reason?.trim() || null,
        },
        include: {
          doctor: {
            select: {
              id: true,
              fullName: true,
              specialization: true,
            },
          },
        },
      });
    } catch (error: unknown) {
      if (this.isAppointmentOverlapConstraintError(error)) {
        throw new ConflictException(
          'The doctor already has an overlapping appointment',
        );
      }
      throw error;
    }
  }

  async findAll(user: AppointmentUser) {
    switch (user.role) {
      case UserRole.PATIENT: {
        const patient = await this.prisma.patientProfile.findUnique({
          where: { userId: user.id },
          select: { id: true },
        });

        if (!patient) {
          throw new NotFoundException('Patient profile not found');
        }

        return this.prisma.appointment.findMany({
          where: { patientId: patient.id },
          orderBy: { startAt: 'desc' },
          include: {
            doctor: {
              select: {
                id: true,
                fullName: true,
                specialization: true,
              },
            },
          },
        });
      }

      case UserRole.DOCTOR: {
        const doctor = await this.prisma.doctorProfile.findUnique({
          where: { userId: user.id },
          select: { id: true },
        });

        if (!doctor) {
          throw new NotFoundException('Doctor profile not found');
        }

        return this.prisma.appointment.findMany({
          where: { doctorId: doctor.id },
          orderBy: { startAt: 'asc' },
          include: {
            patient: {
              select: {
                id: true,
                fullName: true,
                phone: true,
              },
            },
          },
        });
      }

      case UserRole.ADMIN:
      case UserRole.RECEPTIONIST:
        return this.prisma.appointment.findMany({
          orderBy: { startAt: 'asc' },
          include: {
            patient: {
              select: { id: true, fullName: true, phone: true },
            },
            doctor: {
              select: {
                id: true,
                fullName: true,
                specialization: true,
              },
            },
          },
        });

      default:
        throw new ForbiddenException(
          'You do not have permission to view appointments',
        );
    }
  }

  // Get one appointment after checking the current user's access.
  async findOne(user: AppointmentUser, appointmentId: string) {
    await this.getAuthorizedAppointment(user, appointmentId);

    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: {
          select: {
            id: true,
            fullName: true,
            phone: true,
          },
        },
        doctor: {
          select: {
            id: true,
            fullName: true,
            specialization: true,
          },
        },
      },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    return appointment;
  }

  async reschedule(
    user: AppointmentUser,
    appointmentId: string,
    dto: RescheduleAppointmentDto,
  ) {
    const appointment = await this.getAuthorizedAppointment(
      user,
      appointmentId,
    );

    if (
      appointment.status !== AppointmentStatus.SCHEDULED &&
      appointment.status !== AppointmentStatus.CONFIRMED
    ) {
      throw new BadRequestException(
        'Only scheduled or confirmed appointments can be rescheduled',
      );
    }

    const { startAt, endAt } = this.validateTimeRange(
      dto.startAt,
      dto.endAt,
    );

    const doctor = await this.prisma.doctorProfile.findFirst({
      where: {
        id: appointment.doctorId,
        isActive: true,
        department: { is: { isActive: true } },
        user: {
          is: {
            role: UserRole.DOCTOR,
            status: UserStatus.ACTIVE,
          },
        },
      },
      select: { id: true },
    });

    if (!doctor) {
      throw new BadRequestException(
        'Cannot reschedule with an inactive doctor',
      );
    }

    await this.validateDoctorSchedule(doctor.id, startAt, endAt);
    await this.ensureNoOverlap(
      doctor.id,
      startAt,
      endAt,
      appointment.id,
    );

    try {
      return await this.prisma.appointment.update({
        where: { id: appointment.id },
        data: { startAt, endAt },
        include: {
          doctor: {
            select: {
              id: true,
              fullName: true,
              specialization: true,
            },
          },
        },
      });
    } catch (error: unknown) {
      if (this.isAppointmentOverlapConstraintError(error)) {
        throw new ConflictException(
          'The doctor already has an overlapping appointment',
        );
      }
      throw error;
    }
  }

  // Cancel an appointment using the existing status-transition rules.
  async cancel(user: AppointmentUser, appointmentId: string) {
    const appointment = await this.getAuthorizedAppointment(
      user,
      appointmentId,
    );

    return this.updateStatus(user, appointment.id, {
      status: AppointmentStatus.CANCELLED,
    });
  }

  async updateStatus(
    user: AppointmentUser,
    appointmentId: string,
    dto: UpdateAppointmentStatusDto,
  ) {
    const appointment = await this.getAuthorizedAppointment(
      user,
      appointmentId,
    );

    const allowed = this.canChangeStatus(
      user.role,
      appointment.status,
      dto.status,
    );

    if (!allowed) {
      throw new ForbiddenException(
        'You are not allowed to make this appointment status change',
      );
    }

    return this.prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: dto.status },
      include: {
        patient: {
          select: { id: true, fullName: true },
        },
        doctor: {
          select: { id: true, fullName: true },
        },
      },
    });
  }

  private async getAuthorizedAppointment(
    user: AppointmentUser,
    appointmentId: string,
  ) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        status: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    if (user.role === UserRole.PATIENT) {
      const patient = await this.prisma.patientProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });

      if (!patient || patient.id !== appointment.patientId) {
        throw new ForbiddenException(
          'You cannot access another patient’s appointment',
        );
      }
    } else if (user.role === UserRole.DOCTOR) {
      const doctor = await this.prisma.doctorProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });

      if (!doctor || doctor.id !== appointment.doctorId) {
        throw new ForbiddenException(
          'You cannot access another doctor’s appointment',
        );
      }
    } else if (
      user.role !== UserRole.ADMIN &&
      user.role !== UserRole.RECEPTIONIST
    ) {
      throw new ForbiddenException(
        'You do not have permission to access appointments',
      );
    }

    return appointment;
  }

  private canChangeStatus(
    role: UserRole,
    current: AppointmentStatus,
    next: AppointmentStatus,
  ): boolean {
    if (current === next) {
      return true;
    }

    if (
      current === AppointmentStatus.CANCELLED ||
      current === AppointmentStatus.COMPLETED ||
      current === AppointmentStatus.NO_SHOW
    ) {
      return false;
    }

    if (role === UserRole.PATIENT) {
      return (
        (current === AppointmentStatus.SCHEDULED ||
          current === AppointmentStatus.CONFIRMED) &&
        next === AppointmentStatus.CANCELLED
      );
    }

    if (role === UserRole.DOCTOR) {
      return (
        (current === AppointmentStatus.SCHEDULED &&
          next === AppointmentStatus.CONFIRMED) ||
        (current === AppointmentStatus.CONFIRMED &&
          (next === AppointmentStatus.COMPLETED ||
            next === AppointmentStatus.NO_SHOW)) ||
        ((current === AppointmentStatus.SCHEDULED ||
          current === AppointmentStatus.CONFIRMED) &&
          next === AppointmentStatus.CANCELLED)
      );
    }

    if (
      role === UserRole.ADMIN ||
      role === UserRole.RECEPTIONIST
    ) {
      return [
        AppointmentStatus.SCHEDULED,
        AppointmentStatus.CONFIRMED,
        AppointmentStatus.CANCELLED,
        AppointmentStatus.COMPLETED,
        AppointmentStatus.NO_SHOW,
      ].includes(next);
    }

    return false;
  }

  private validateTimeRange(startValue: string, endValue: string) {
    const startAt = new Date(startValue);
    const endAt = new Date(endValue);

    if (
      Number.isNaN(startAt.getTime()) ||
      Number.isNaN(endAt.getTime())
    ) {
      throw new BadRequestException('Invalid appointment date/time');
    }

    if (startAt <= new Date()) {
      throw new BadRequestException(
        'Appointment must be scheduled in the future',
      );
    }

    if (endAt <= startAt) {
      throw new BadRequestException(
        'endAt must be later than startAt',
      );
    }

    return { startAt, endAt };
  }

  private async validateDoctorSchedule(
    doctorId: string,
    startAt: Date,
    endAt: Date,
  ) {
    // Schedule times are stored as local wall-clock times.
    // Until the clinic timezone is configured, use the server's local timezone.
    if (startAt.toDateString() !== endAt.toDateString()) {
      throw new BadRequestException(
        'An appointment must start and end on the same local day',
      );
    }

    const weekdayNames: DayOfWeek[] = [
      DayOfWeek.SUNDAY,
      DayOfWeek.MONDAY,
      DayOfWeek.TUESDAY,
      DayOfWeek.WEDNESDAY,
      DayOfWeek.THURSDAY,
      DayOfWeek.FRIDAY,
      DayOfWeek.SATURDAY,
    ];

    const dayOfWeek = weekdayNames[startAt.getDay()];
    const startMinutes = startAt.getHours() * 60 + startAt.getMinutes();
    const endMinutes = endAt.getHours() * 60 + endAt.getMinutes();

    const schedules = await this.prisma.doctorSchedule.findMany({
      where: {
        doctorId,
        dayOfWeek,
        isActive: true,
      },
      select: { startTime: true, endTime: true },
    });

    const fitsSchedule = schedules.some((schedule) => {
      const scheduleStart = this.toMinutes(schedule.startTime);
      const scheduleEnd = this.toMinutes(schedule.endTime);

      return (
        startMinutes >= scheduleStart &&
        endMinutes <= scheduleEnd
      );
    });

    if (!fitsSchedule) {
      throw new BadRequestException(
        'Appointment time is outside the doctor’s active schedule',
      );
    }
  }

  private async ensureNoOverlap(
    doctorId: string,
    startAt: Date,
    endAt: Date,
    excludeAppointmentId?: string,
  ) {
    const conflict = await this.prisma.appointment.findFirst({
      where: {
        doctorId,
        status: { in: ACTIVE_APPOINTMENT_STATUSES },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
        ...(excludeAppointmentId && {
          id: { not: excludeAppointmentId },
        }),
      },
      select: { id: true },
    });

    if (conflict) {
      throw new ConflictException(
        'The doctor already has an overlapping appointment',
      );
    }
  }

  private isAppointmentOverlapConstraintError(
    error: unknown,
  ): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const details = [
      error.message,
      JSON.stringify(
        error as Error & {
          code?: string;
          meta?: unknown;
        },
      ),
    ].join(' ');

    return (
      details.includes(
        'Appointment_no_overlapping_active_doctor_appointments',
      ) || details.includes('23P01')
    );
  }

  private toMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }
}

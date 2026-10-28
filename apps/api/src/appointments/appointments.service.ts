
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  AppointmentStatus,
  DayOfWeek,
  EmailOutboxEvent,
  UserRole,
  UserStatus,
} from '../generated/prisma/client.js';

import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { EmailOutboxService } from '../email/email-outbox.service.js';
import { AppointmentRemindersProcessor } from '../appointment-reminders/appointment-reminders.processor.js';

import { CreateAppointmentDto } from './dto/create-appointment.dto.js';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto.js';
import { UpdateAppointmentStatusDto } from './dto/update-appointment-status.dto.js';

type AppointmentUser = {
  id: string;
  email: string;
  role: UserRole;
};

type AppointmentReminderActions = {
  scheduleForAppointment?: (appointmentId: string) => Promise<void>;
  cancelForAppointment?: (appointmentId: string) => Promise<void>;
};

const ACTIVE_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
];

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly emailOutboxService: EmailOutboxService,
    private readonly appointmentRemindersService: AppointmentRemindersProcessor,
  ) {}

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
      select: {
        id: true,
        fullName: true,
      },
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
      select: {
        id: true,
        userId: true,
        fullName: true,
        user: {
          select: {
            email: true,
          },
        },
      },
    });

    if (!doctor) {
      throw new NotFoundException('Active doctor not found');
    }

    await this.validateDoctorSchedule(doctor.id, startAt, endAt);
    await this.ensureNoOverlap(doctor.id, startAt, endAt);

    let appointment: Awaited<
      ReturnType<typeof this.prisma.appointment.create>
    >;

    try {
      appointment = await this.prisma.appointment.create({
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

    // Schedule reminders without failing the booking if scheduling fails.
    await this.scheduleRemindersSafely(appointment.id);

    await this.notifyAppointmentParticipants({
      appointmentId: appointment.id,
      event: 'BOOKED',
      dedupeSuffix: 'BOOKED',
      patientUserId: user.id,
      doctorUserId: doctor.userId,
      patientMessage: `Your appointment has been booked for ${startAt.toLocaleString()}.`,
      doctorMessage: `A new appointment has been booked for ${startAt.toLocaleString()}.`,
    });

    // Queue emails for asynchronous delivery by the outbox processor.
    await this.sendAppointmentEmails(EmailOutboxEvent.BOOKED, {
      appointmentId: appointment.id,
      patientEmail: user.email,
      patientName: patient.fullName,
      doctorEmail: doctor.user.email,
      doctorName: doctor.fullName,
      startAt,
      endAt,
    });

    return appointment;
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

    if (
      appointment.startAt.getTime() === startAt.getTime() &&
      appointment.endAt.getTime() === endAt.getTime()
    ) {
      return this.prisma.appointment.update({
        where: { id: appointment.id },
        data: {},
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
      select: {
        id: true,
        userId: true,
      },
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

    let updatedAppointment: Awaited<
      ReturnType<typeof this.prisma.appointment.update>
    >;

    try {
      updatedAppointment = await this.prisma.appointment.update({
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

    // Cancel stale reminders and schedule them for the new appointment time.
    await this.scheduleRemindersSafely(updatedAppointment.id);

    const patient = await this.prisma.patientProfile.findUnique({
      where: { id: appointment.patientId },
      select: { userId: true },
    });

    await this.notifyAppointmentParticipants({
      appointmentId: appointment.id,
      event: 'RESCHEDULED',
      dedupeSuffix:
        `${appointment.startAt.toISOString()}_` +
        `${appointment.endAt.toISOString()}_` +
        `${startAt.toISOString()}_${endAt.toISOString()}`,
      patientUserId: patient?.userId,
      doctorUserId: doctor.userId,
      patientMessage: `Your appointment has been rescheduled to ${startAt.toLocaleString()}.`,
      doctorMessage: `An appointment has been rescheduled to ${startAt.toLocaleString()}.`,
    });

    return updatedAppointment;
  }

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

    if (appointment.status === dto.status) {
      return this.prisma.appointment.findUnique({
        where: { id: appointment.id },
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

    const updatedAppointment = await this.prisma.appointment.update({
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

    // No reminders should remain active for terminal appointment statuses.
    if (
      dto.status === AppointmentStatus.CANCELLED ||
      dto.status === AppointmentStatus.COMPLETED ||
      dto.status === AppointmentStatus.NO_SHOW
    ) {
      await this.cancelRemindersSafely(appointment.id);
    }

    const [patient, doctor] = await Promise.all([
      this.prisma.patientProfile.findUnique({
        where: { id: appointment.patientId },
        select: {
          userId: true,
          user: {
            select: { email: true },
          },
        },
      }),
      this.prisma.doctorProfile.findUnique({
        where: { id: appointment.doctorId },
        select: {
          userId: true,
          user: {
            select: { email: true },
          },
        },
      }),
    ]);

    const event = this.getStatusEvent(dto.status);

    const statusMessages: Record<AppointmentStatus, string> = {
      [AppointmentStatus.SCHEDULED]: 'has been scheduled',
      [AppointmentStatus.CONFIRMED]: 'has been confirmed',
      [AppointmentStatus.CANCELLED]: 'has been cancelled',
      [AppointmentStatus.COMPLETED]: 'has been marked as completed',
      [AppointmentStatus.NO_SHOW]: 'has been marked as a no-show',
    };

    const message = `Your appointment ${statusMessages[dto.status]}.`;

    await this.notifyAppointmentParticipants({
      appointmentId: appointment.id,
      event,
      dedupeSuffix:
        `${appointment.status}_TO_${dto.status}_` +
        `${updatedAppointment.updatedAt instanceof Date
          ? updatedAppointment.updatedAt.toISOString()
          : Date.now()}`,
      patientUserId: patient?.userId,
      doctorUserId: doctor?.userId,
      patientMessage: message,
      doctorMessage: `An appointment ${statusMessages[dto.status]}.`,
    });

    if (dto.status === AppointmentStatus.CANCELLED) {
      await this.sendAppointmentEmails(EmailOutboxEvent.CANCELLED, {
        appointmentId: updatedAppointment.id,
        patientEmail: patient?.user?.email,
        patientName: updatedAppointment.patient.fullName,
        doctorEmail: doctor?.user?.email,
        doctorName: updatedAppointment.doctor.fullName,
        startAt: updatedAppointment.startAt,
        endAt: updatedAppointment.endAt,
      });
    }

    return updatedAppointment;
  }

  private async scheduleRemindersSafely(
    appointmentId: string,
  ): Promise<void> {
    try {
      const reminders = this.appointmentRemindersService as unknown as
        AppointmentReminderActions;

      if (!reminders.scheduleForAppointment) {
        this.logger.warn(
          `Reminder scheduling is unavailable for appointment ${appointmentId}`,
        );
        return;
      }

      await reminders.scheduleForAppointment(appointmentId);
    } catch (error: unknown) {
      const reason =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(
        `Could not schedule reminders for appointment ${appointmentId}: ${reason}`,
      );
    }
  }

  private async cancelRemindersSafely(
    appointmentId: string,
  ): Promise<void> {
    try {
      const reminders = this.appointmentRemindersService as unknown as
        AppointmentReminderActions;

      if (!reminders.cancelForAppointment) {
        this.logger.warn(
          `Reminder cancellation is unavailable for appointment ${appointmentId}`,
        );
        return;
      }

      await reminders.cancelForAppointment(appointmentId);
    } catch (error: unknown) {
      const reason =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(
        `Could not cancel reminders for appointment ${appointmentId}: ${reason}`,
      );
    }
  }

  private async sendAppointmentEmails(
    event: EmailOutboxEvent,
    input: {
      appointmentId: string;
      patientEmail?: string | null;
      patientName?: string | null;
      doctorEmail?: string | null;
      doctorName?: string | null;
      startAt: Date;
      endAt: Date;
    },
  ): Promise<void> {
    if (
      !input.patientEmail?.trim() ||
      !input.patientName?.trim() ||
      !input.doctorEmail?.trim() ||
      !input.doctorName?.trim()
    ) {
      this.logger.warn(
        `Skipping appointment email enqueue because recipient details are incomplete for appointment ${input.appointmentId}.`,
      );
      return;
    }

    try {
      await this.emailOutboxService.enqueueAppointmentEmails({
        appointmentId: input.appointmentId,
        event,
        patientEmail: input.patientEmail,
        patientName: input.patientName,
        doctorEmail: input.doctorEmail,
        doctorName: input.doctorName,
        startAt: input.startAt,
        endAt: input.endAt,
      });
    } catch (error: unknown) {
      const reason =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(
        `Could not enqueue appointment email jobs for appointment ${input.appointmentId}: ${reason}`,
      );
    }
  }

  private async notifyAppointmentParticipants(input: {
    appointmentId: string;
    event: string;
    dedupeSuffix: string;
    patientUserId?: string | null;
    doctorUserId?: string | null;
    patientMessage: string;
    doctorMessage: string;
  }) {
    const recipients = [
      input.patientUserId
        ? {
            userId: input.patientUserId,
            title: this.getNotificationTitle(input.event),
            message: input.patientMessage,
          }
        : null,
      input.doctorUserId
        ? {
            userId: input.doctorUserId,
            title: this.getNotificationTitle(input.event),
            message: input.doctorMessage,
          }
        : null,
    ].filter(
      (
        recipient,
      ): recipient is {
        userId: string;
        title: string;
        message: string;
      } => recipient !== null,
    );

    if (recipients.length === 0) {
      return;
    }

    await this.notificationsService.createAppointmentEventNotifications({
      appointmentId: input.appointmentId,
      event: input.event,
      dedupeSuffix: input.dedupeSuffix,
      recipients,
    });
  }

  private getNotificationTitle(event: string): string {
    const titles: Record<string, string> = {
      BOOKED: 'Appointment booked',
      RESCHEDULED: 'Appointment rescheduled',
      CONFIRMED: 'Appointment confirmed',
      CANCELLED: 'Appointment cancelled',
      COMPLETED: 'Appointment completed',
      NO_SHOW: 'Appointment status updated',
      STATUS_UPDATED: 'Appointment status updated',
    };

    return titles[event] ?? 'Appointment status updated';
  }

  private getStatusEvent(status: AppointmentStatus): string {
    switch (status) {
      case AppointmentStatus.SCHEDULED:
        return 'STATUS_UPDATED';
      case AppointmentStatus.CONFIRMED:
        return 'CONFIRMED';
      case AppointmentStatus.CANCELLED:
        return 'CANCELLED';
      case AppointmentStatus.COMPLETED:
        return 'COMPLETED';
      case AppointmentStatus.NO_SHOW:
        return 'NO_SHOW';
      default:
        return 'STATUS_UPDATED';
    }
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
        startAt: true,
        endAt: true,
        updatedAt: true,
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

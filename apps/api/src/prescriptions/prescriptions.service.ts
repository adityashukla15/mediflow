
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  AuditAction,
  PrescriptionStatus,
  UserRole,
  UserStatus,
} from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategies.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreatePrescriptionDto } from './dto/create-prescription.dto.js';
import type { UpdatePrescriptionDto } from './dto/update-prescription.dto.js';

@Injectable()
export class PrescriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getActiveDoctor(user: AuthenticatedUser) {
    if (user.role !== UserRole.DOCTOR) {
      throw new ForbiddenException('Only doctors can manage prescriptions');
    }

    const doctor = await this.prisma.doctorProfile.findFirst({
      where: {
        userId: user.id,
        isActive: true,
        user: {
          is: {
            role: UserRole.DOCTOR,
            status: UserStatus.ACTIVE,
          },
        },
        department: { is: { isActive: true } },
      },
      select: { id: true },
    });

    if (!doctor) {
      throw new ForbiddenException('Active doctor profile required');
    }

    return doctor;
  }

  async create(user: AuthenticatedUser, dto: CreatePrescriptionDto) {
    const doctor = await this.getActiveDoctor(user);

    const patient = await this.prisma.patientProfile.findUnique({
      where: { id: dto.patientId },
      select: { id: true },
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    const appointment = await this.prisma.appointment.findFirst({
      where: {
        id: dto.appointmentId,
        patientId: patient.id,
        doctorId: doctor.id,
      },
      select: { id: true },
    });

    if (!appointment) {
      throw new BadRequestException(
        'Appointment must belong to this patient and doctor',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const prescription = await tx.prescription.create({
        data: {
          patientId: patient.id,
          doctorId: doctor.id,
          appointmentId: appointment.id,
          notes: dto.notes,
          items: {
            create: dto.items.map((item) => ({ ...item })),
          },
        },
        include: { items: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: AuditAction.PRESCRIPTION_CREATED,
          entityType: 'Prescription',
          entityId: prescription.id,
          metadata: { itemCount: prescription.items.length },
        },
      });

      return prescription;
    });
  }

  async findAll(user: AuthenticatedUser) {
    if (user.role === UserRole.DOCTOR) {
      const doctor = await this.getActiveDoctor(user);

      return this.prisma.prescription.findMany({
        where: { doctorId: doctor.id },
        orderBy: { createdAt: 'desc' },
        include: { items: true },
      });
    }

    if (user.role === UserRole.PATIENT) {
      const patient = await this.prisma.patientProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });

      if (!patient) {
        throw new NotFoundException('Patient profile not found');
      }

      return this.prisma.prescription.findMany({
        where: { patientId: patient.id },
        orderBy: { createdAt: 'desc' },
        include: { items: true },
      });
    }

    throw new ForbiddenException('You cannot access prescription history');
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const prescription = await this.prisma.prescription.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!prescription) {
      throw new NotFoundException('Prescription not found');
    }

    if (user.role === UserRole.DOCTOR) {
      const doctor = await this.getActiveDoctor(user);

      if (prescription.doctorId !== doctor.id) {
        throw new ForbiddenException('You cannot access this prescription');
      }

      return prescription;
    }

    if (user.role === UserRole.PATIENT) {
      const patient = await this.prisma.patientProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });

      if (!patient || prescription.patientId !== patient.id) {
        throw new ForbiddenException('You cannot access this prescription');
      }

      return prescription;
    }

    throw new ForbiddenException('You cannot access this prescription');
  }

  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdatePrescriptionDto,
  ) {
    const doctor = await this.getActiveDoctor(user);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.prescription.findUnique({
        where: { id },
        select: { id: true, doctorId: true, status: true },
      });

      if (!existing) {
        throw new NotFoundException('Prescription not found');
      }

      if (existing.doctorId !== doctor.id) {
        throw new ForbiddenException('You cannot update this prescription');
      }

      if (existing.status !== PrescriptionStatus.ACTIVE) {
        throw new BadRequestException('Only active prescriptions can be updated');
      }

      const prescription = await tx.prescription.update({
        where: { id },
        data: {
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.items !== undefined
            ? {
                items: {
                  deleteMany: {},
                  create: dto.items.map((item) => ({ ...item })),
                },
              }
            : {}),
        },
        include: { items: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: AuditAction.PRESCRIPTION_UPDATED,
          entityType: 'Prescription',
          entityId: prescription.id,
          metadata: { itemsReplaced: dto.items !== undefined },
        },
      });

      return prescription;
    });
  }

  async cancel(user: AuthenticatedUser, id: string) {
    const doctor = await this.getActiveDoctor(user);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.prescription.findUnique({
        where: { id },
        select: { id: true, doctorId: true, status: true },
      });

      if (!existing) {
        throw new NotFoundException('Prescription not found');
      }

      if (existing.doctorId !== doctor.id) {
        throw new ForbiddenException('You cannot cancel this prescription');
      }

      if (existing.status !== PrescriptionStatus.ACTIVE) {
        throw new BadRequestException('Only active prescriptions can be cancelled');
      }

      const prescription = await tx.prescription.update({
        where: { id },
        data: { status: PrescriptionStatus.CANCELLED },
        include: { items: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: AuditAction.PRESCRIPTION_CANCELLED,
          entityType: 'Prescription',
          entityId: prescription.id,
        },
      });

      return prescription;
    });
  }
}

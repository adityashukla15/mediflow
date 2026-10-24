
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  AuditAction,
  LabReportStatus,
  UserRole,
  UserStatus,
} from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategies.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateLabReportDto } from './dto/create-lab-report.dto.js';
import type { UpdateLabReportDto } from './dto/update-lab-report.dto.js';

@Injectable()
export class LabReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getActiveDoctor(user: AuthenticatedUser) {
    if (user.role !== UserRole.DOCTOR) {
      throw new ForbiddenException('Only doctors can manage lab reports');
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

  private async validateDocument(
    documentId: string | undefined,
    patientId: string,
  ) {
    if (!documentId) return;

    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, patientId: true },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    if (document.patientId !== patientId) {
      throw new ForbiddenException(
        'The document does not belong to this patient',
      );
    }
  }

  async create(user: AuthenticatedUser, dto: CreateLabReportDto) {
    const doctor = await this.getActiveDoctor(user);

    const patient = await this.prisma.patientProfile.findUnique({
      where: { id: dto.patientId },
      select: { id: true },
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    if (dto.appointmentId) {
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
    }

    await this.validateDocument(dto.documentId, patient.id);

    return this.prisma.$transaction(async (tx) => {
      const report = await tx.labReport.create({
        data: {
          patientId: patient.id,
          doctorId: doctor.id,
          appointmentId: dto.appointmentId,
          testName: dto.testName,
          labName: dto.labName,
          resultSummary: dto.resultSummary,
          documentId: dto.documentId,
          status: dto.status ?? LabReportStatus.PENDING,
          reportedAt: dto.reportedAt ? new Date(dto.reportedAt) : undefined,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: AuditAction.LAB_REPORT_CREATED,
          entityType: 'LabReport',
          entityId: report.id,
          metadata: { status: report.status },
        },
      });

      return report;
    });
  }

  async findAll(user: AuthenticatedUser) {
    if (user.role === UserRole.DOCTOR) {
      const doctor = await this.getActiveDoctor(user);

      return this.prisma.labReport.findMany({
        where: { doctorId: doctor.id },
        orderBy: { createdAt: 'desc' },
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

      return this.prisma.labReport.findMany({
        where: { patientId: patient.id },
        orderBy: { createdAt: 'desc' },
      });
    }

    throw new ForbiddenException('You cannot access lab reports');
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const report = await this.prisma.labReport.findUnique({
      where: { id },
    });

    if (!report) {
      throw new NotFoundException('Lab report not found');
    }

    if (user.role === UserRole.DOCTOR) {
      const doctor = await this.getActiveDoctor(user);

      if (report.doctorId !== doctor.id) {
        throw new ForbiddenException('You cannot access this lab report');
      }

      return report;
    }

    if (user.role === UserRole.PATIENT) {
      const patient = await this.prisma.patientProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });

      if (!patient || report.patientId !== patient.id) {
        throw new ForbiddenException('You cannot access this lab report');
      }

      return report;
    }

    throw new ForbiddenException('You cannot access this lab report');
  }

  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateLabReportDto,
  ) {
    const doctor = await this.getActiveDoctor(user);

    const existing = await this.prisma.labReport.findUnique({
      where: { id },
      select: { id: true, doctorId: true, patientId: true },
    });

    if (!existing) {
      throw new NotFoundException('Lab report not found');
    }

    if (existing.doctorId !== doctor.id) {
      throw new ForbiddenException('You cannot update this lab report');
    }

    if (dto.documentId !== undefined) {
      await this.validateDocument(dto.documentId, existing.patientId);
    }

    return this.prisma.$transaction(async (tx) => {
      const report = await tx.labReport.update({
        where: { id },
        data: {
          ...(dto.testName !== undefined ? { testName: dto.testName } : {}),
          ...(dto.labName !== undefined ? { labName: dto.labName } : {}),
          ...(dto.resultSummary !== undefined
            ? { resultSummary: dto.resultSummary }
            : {}),
          ...(dto.documentId !== undefined
            ? { documentId: dto.documentId }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.reportedAt !== undefined
            ? { reportedAt: new Date(dto.reportedAt) }
            : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: AuditAction.LAB_REPORT_UPDATED,
          entityType: 'LabReport',
          entityId: report.id,
          metadata: { status: report.status },
        },
      });

      return report;
    });
  }
}

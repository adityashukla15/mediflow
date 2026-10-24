
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  UserRole,
  UserStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateMedicalRecordDto } from './dto/create-medical-record.dto.js';
import { ListMedicalRecordsQueryDto } from './dto/list-medical-records-query.dto.js';

type MedicalRecordUser = {
  id: string;
  email: string;
  role: UserRole;
};

@Injectable()
export class MedicalRecordsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: MedicalRecordUser, dto: CreateMedicalRecordDto) {
    if (user.role !== UserRole.DOCTOR) {
      throw new ForbiddenException(
        'Only doctors can create medical records',
      );
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
        department: {
          is: { isActive: true },
        },
      },
      select: { id: true },
    });

    if (!doctor) {
      throw new NotFoundException('Active doctor profile not found');
    }

    const patient = await this.prisma.patientProfile.findUnique({
      where: { id: dto.patientId },
      select: { id: true },
    });

    if (!patient) {
      throw new NotFoundException('Patient profile not found');
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
        throw new NotFoundException(
          'Appointment not found for this patient and doctor',
        );
      }
    } else {
      const priorAppointment = await this.prisma.appointment.findFirst({
        where: {
          patientId: patient.id,
          doctorId: doctor.id,
        },
        select: { id: true },
      });

      if (!priorAppointment) {
        throw new ForbiddenException(
          'A clinical relationship with this patient is required',
        );
      }
    }

    return this.prisma.medicalRecord.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        appointmentId: dto.appointmentId ?? null,
        recordType: dto.recordType,
        title: dto.title.trim(),
        description: dto.description.trim(),
      },
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        appointmentId: true,
        recordType: true,
        title: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findAll(
    user: MedicalRecordUser,
    query: ListMedicalRecordsQueryDto,
  ) {
    if (user.role === UserRole.PATIENT) {
      const patient = await this.prisma.patientProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });

      if (!patient) {
        throw new NotFoundException('Patient profile not found');
      }

      return this.prisma.medicalRecord.findMany({
        where: {
          patientId: patient.id,
          ...(query.appointmentId
            ? { appointmentId: query.appointmentId }
            : {}),
          ...(query.recordType ? { recordType: query.recordType } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
        select: {
          id: true,
          patientId: true,
          doctorId: true,
          appointmentId: true,
          recordType: true,
          title: true,
          description: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    }

    if (user.role === UserRole.DOCTOR) {
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
        },
        select: { id: true },
      });

      if (!doctor) {
        throw new NotFoundException('Active doctor profile not found');
      }

      return this.prisma.medicalRecord.findMany({
        where: {
          doctorId: doctor.id,
          ...(query.patientId ? { patientId: query.patientId } : {}),
          ...(query.appointmentId
            ? { appointmentId: query.appointmentId }
            : {}),
          ...(query.recordType ? { recordType: query.recordType } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
        select: {
          id: true,
          patientId: true,
          doctorId: true,
          appointmentId: true,
          recordType: true,
          title: true,
          description: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    }

    throw new ForbiddenException(
      'You do not have permission to access medical records',
    );
  }

  /**
   * Lists records for a specific patient.
   * Patients can access only their own records.
   * Doctors need a clinical relationship with the patient.
   * Receptionist/admin access remains denied by default.
   */
  async findForPatient(
    user: MedicalRecordUser,
    patientId: string,
    query: ListMedicalRecordsQueryDto,
  ) {
    if (user.role === UserRole.PATIENT) {
      const patient = await this.prisma.patientProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });

      if (!patient || patient.id !== patientId) {
        throw new NotFoundException('Patient not found');
      }

      return this.prisma.medicalRecord.findMany({
        where: {
          patientId: patient.id,
          ...(query.appointmentId
            ? { appointmentId: query.appointmentId }
            : {}),
          ...(query.recordType
            ? { recordType: query.recordType }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
        select: {
          id: true,
          patientId: true,
          doctorId: true,
          appointmentId: true,
          recordType: true,
          title: true,
          description: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    }

    if (user.role === UserRole.DOCTOR) {
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
          department: {
            is: { isActive: true },
          },
        },
        select: { id: true },
      });

      if (!doctor) {
        throw new NotFoundException('Active doctor profile not found');
      }

      const relationship = await this.prisma.appointment.findFirst({
        where: {
          patientId,
          doctorId: doctor.id,
        },
        select: { id: true },
      });

      if (!relationship) {
        throw new ForbiddenException(
          'A clinical relationship with this patient is required',
        );
      }

      return this.prisma.medicalRecord.findMany({
        where: {
          patientId,
          doctorId: doctor.id,
          ...(query.appointmentId
            ? { appointmentId: query.appointmentId }
            : {}),
          ...(query.recordType
            ? { recordType: query.recordType }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
        select: {
          id: true,
          patientId: true,
          doctorId: true,
          appointmentId: true,
          recordType: true,
          title: true,
          description: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    }

    throw new ForbiddenException(
      'You do not have permission to access medical records',
    );
  }

  async findOne(user: MedicalRecordUser, recordId: string) {
    const record = await this.prisma.medicalRecord.findUnique({
      where: { id: recordId },
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        appointmentId: true,
        recordType: true,
        title: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!record) {
      throw new NotFoundException('Medical record not found');
    }

    if (user.role === UserRole.PATIENT) {
      const patient = await this.prisma.patientProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });

      if (!patient || patient.id !== record.patientId) {
        throw new NotFoundException('Medical record not found');
      }

      return record;
    }

    if (user.role === UserRole.DOCTOR) {
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
        },
        select: { id: true },
      });

      if (!doctor || doctor.id !== record.doctorId) {
        throw new NotFoundException('Medical record not found');
      }

      return record;
    }

    throw new ForbiddenException(
      'You do not have permission to access medical records',
    );
  }
}

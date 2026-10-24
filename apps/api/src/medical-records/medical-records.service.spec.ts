
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import {
  MedicalRecordType,
  UserRole,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MedicalRecordsService } from './medical-records.service.js';

describe('MedicalRecordsService', () => {
  let service: MedicalRecordsService;

  const prisma = {
    doctorProfile: {
      findFirst: vi.fn(),
    },
    patientProfile: {
      findUnique: vi.fn(),
    },
    appointment: {
      findFirst: vi.fn(),
    },
    medicalRecord: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  };

  const doctorUser = {
    id: 'user-doctor-1',
    email: 'doctor@example.com',
    role: UserRole.DOCTOR,
  };

  const patientUser = {
    id: 'user-patient-1',
    email: 'patient@example.com',
    role: UserRole.PATIENT,
  };

  const adminUser = {
    id: 'user-admin-1',
    email: 'admin@example.com',
    role: UserRole.ADMIN,
  };

  const doctorProfile = { id: 'doctor-profile-1' };
  const patientProfile = { id: 'patient-profile-1' };

  const record = {
    id: 'record-1',
    patientId: patientProfile.id,
    doctorId: doctorProfile.id,
    appointmentId: 'appointment-1',
    recordType: MedicalRecordType.CONSULTATION,
    title: 'Consultation notes',
    description: 'Patient consultation notes',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MedicalRecordsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<MedicalRecordsService>(MedicalRecordsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('allows a doctor to create a record for an existing patient and matching appointment', async () => {
    prisma.doctorProfile.findFirst.mockResolvedValue(doctorProfile);
    prisma.patientProfile.findUnique.mockResolvedValue(patientProfile);
    prisma.appointment.findFirst.mockResolvedValue({ id: 'appointment-1' });
    prisma.medicalRecord.create.mockResolvedValue(record);

    const result = await service.create(doctorUser, {
      patientId: patientProfile.id,
      appointmentId: 'appointment-1',
      recordType: MedicalRecordType.CONSULTATION,
      title: ' Consultation notes ',
      description: ' Patient consultation notes ',
    });

    expect(result).toEqual(record);
    expect(prisma.appointment.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'appointment-1',
        patientId: patientProfile.id,
        doctorId: doctorProfile.id,
      },
      select: { id: true },
    });

    expect(prisma.medicalRecord.create).toHaveBeenCalledWith({
      data: {
        patientId: patientProfile.id,
        doctorId: doctorProfile.id,
        appointmentId: 'appointment-1',
        recordType: MedicalRecordType.CONSULTATION,
        title: 'Consultation notes',
        description: 'Patient consultation notes',
      },
      select: expect.any(Object),
    });
  });

  it('rejects record creation by a non-doctor', async () => {
    await expect(
      service.create(patientUser, {
        patientId: patientProfile.id,
        recordType: MedicalRecordType.CONSULTATION,
        title: 'Consultation notes',
        description: 'Notes',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.doctorProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.medicalRecord.create).not.toHaveBeenCalled();
  });

  it('rejects record creation when the doctor profile is missing', async () => {
    prisma.doctorProfile.findFirst.mockResolvedValue(null);

    await expect(
      service.create(doctorUser, {
        patientId: patientProfile.id,
        recordType: MedicalRecordType.CONSULTATION,
        title: 'Consultation notes',
        description: 'Notes',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.medicalRecord.create).not.toHaveBeenCalled();
  });

  it('rejects record creation for a patient who does not exist', async () => {
    prisma.doctorProfile.findFirst.mockResolvedValue(doctorProfile);
    prisma.patientProfile.findUnique.mockResolvedValue(null);

    await expect(
      service.create(doctorUser, {
        patientId: patientProfile.id,
        recordType: MedicalRecordType.CONSULTATION,
        title: 'Consultation notes',
        description: 'Notes',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.medicalRecord.create).not.toHaveBeenCalled();
  });

  it('rejects an appointment that does not belong to both the patient and doctor', async () => {
    prisma.doctorProfile.findFirst.mockResolvedValue(doctorProfile);
    prisma.patientProfile.findUnique.mockResolvedValue(patientProfile);
    prisma.appointment.findFirst.mockResolvedValue(null);

    await expect(
      service.create(doctorUser, {
        patientId: patientProfile.id,
        appointmentId: 'another-appointment',
        recordType: MedicalRecordType.CONSULTATION,
        title: 'Consultation notes',
        description: 'Notes',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.medicalRecord.create).not.toHaveBeenCalled();
  });

  it('returns only the signed-in patient records, ignoring a different patientId filter', async () => {
    prisma.patientProfile.findUnique.mockResolvedValue(patientProfile);
    prisma.medicalRecord.findMany.mockResolvedValue([record]);

    const result = await service.findAll(patientUser, {
      patientId: 'some-other-patient',
      limit: 20,
      offset: 0,
    });

    expect(result).toEqual([record]);
    expect(prisma.medicalRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { patientId: patientProfile.id },
        take: 20,
        skip: 0,
      }),
    );
  });

  it('allows a doctor to list only records authored by that doctor', async () => {
    prisma.doctorProfile.findFirst.mockResolvedValue(doctorProfile);
    prisma.medicalRecord.findMany.mockResolvedValue([record]);

    await service.findAll(doctorUser, {
      patientId: patientProfile.id,
      limit: 10,
      offset: 0,
    });

    expect(prisma.medicalRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          doctorId: doctorProfile.id,
          patientId: patientProfile.id,
        },
        take: 10,
        skip: 0,
      }),
    );
  });

  it('does not allow a doctor to read another doctor’s record', async () => {
    prisma.medicalRecord.findUnique.mockResolvedValue(record);
    prisma.doctorProfile.findFirst.mockResolvedValue({
      id: 'different-doctor-profile',
    });

    await expect(
      service.findOne(doctorUser, record.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not allow a patient to read another patient’s record', async () => {
    prisma.medicalRecord.findUnique.mockResolvedValue(record);
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'different-patient-profile',
    });

    await expect(
      service.findOne(patientUser, record.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('denies medical record listing to administrators by default', async () => {
    await expect(
      service.findAll(adminUser, { limit: 20, offset: 0 }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.medicalRecord.findMany).not.toHaveBeenCalled();
  });

  it('returns not found when a record ID does not exist', async () => {
    prisma.medicalRecord.findUnique.mockResolvedValue(null);

    await expect(
      service.findOne(patientUser, 'missing-record'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

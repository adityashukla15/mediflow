
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';

import {
  MedicalRecordType,
  UserRole,
} from '../src/generated/prisma/client.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Medical Records API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const password = 'TestPassword@123';
  const userIds: string[] = [];
  const patientProfileIds: string[] = [];
  const doctorProfileIds: string[] = [];
  const appointmentIds: string[] = [];
  const recordIds: string[] = [];
  const departmentIds: string[] = [];

  let patientProfileId: string;
  let otherPatientProfileId: string;
  let doctorProfileId: string;

  let patientToken: string;
  let otherPatientToken: string;
  let doctorToken: string;
  let otherDoctorToken: string;
  let adminToken: string;
  let receptionistToken: string;

  let createdRecordId: string;

  async function createUser(role: UserRole = UserRole.PATIENT) {
    const email = `medical-records-e2e-${randomUUID()}@example.com`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);

    const user = await prisma.user.update({
      where: { email },
      data: { role },
      select: { id: true },
    });

    userIds.push(user.id);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    return {
      userId: user.id,
      token: login.body.accessToken as string,
    };
  }

  async function createPatient() {
    const user = await createUser();

    const profile = await prisma.patientProfile.create({
      data: {
        userId: user.userId,
        fullName: 'Medical Records E2E Patient',
      },
    });

    patientProfileIds.push(profile.id);

    return {
      userId: user.userId,
      profileId: profile.id,
      token: user.token,
    };
  }

  async function createDoctor() {
    const user = await createUser(UserRole.DOCTOR);

    const department = await prisma.department.create({
      data: {
        name: `Medical Records E2E ${randomUUID()}`,
        description: 'Temporary E2E department',
        isActive: true,
      },
    });

    departmentIds.push(department.id);

    const profile = await prisma.doctorProfile.create({
      data: {
        userId: user.userId,
        departmentId: department.id,
        fullName: 'Medical Records E2E Doctor',
        specialization: 'General Medicine',
        consultationFee: 500,
        isActive: true,
      },
    });

    doctorProfileIds.push(profile.id);

    return {
      userId: user.userId,
      profileId: profile.id,
      token: user.token,
    };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule =
      await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

    app = moduleFixture.createNestApplication();

    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    prisma = app.get(PrismaService);

    const patient = await createPatient();
    patientProfileId = patient.profileId;
    patientToken = patient.token;

    const otherPatient = await createPatient();
    otherPatientProfileId = otherPatient.profileId;
    otherPatientToken = otherPatient.token;

    const doctor = await createDoctor();
    doctorProfileId = doctor.profileId;
    doctorToken = doctor.token;

    const otherDoctor = await createDoctor();
    otherDoctorToken = otherDoctor.token;

    adminToken = (await createUser(UserRole.ADMIN)).token;
    receptionistToken = (
      await createUser(UserRole.RECEPTIONIST)
    ).token;

    // Create a clinical relationship between the patient and doctor.
    const startAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    );
    startAt.setUTCHours(10, 0, 0, 0);

    const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

    const appointment = await prisma.appointment.create({
      data: {
        patientId: patientProfileId,
        doctorId: doctorProfileId,
        startAt,
        endAt,
        reason: 'E2E medical record test',
      },
    });

    appointmentIds.push(appointment.id);

    const record = await request(app.getHttpServer())
      .post('/api/v1/medical-records')
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        patientId: patientProfileId,
        appointmentId: appointment.id,
        recordType: MedicalRecordType.CONSULTATION,
        title: 'E2E Consultation',
        description: 'Patient consultation test record.',
      })
      .expect(201);

    createdRecordId = record.body.id;
    recordIds.push(createdRecordId);
  });

  afterAll(async () => {
    try {
      if (recordIds.length) {
        await prisma.medicalRecord.deleteMany({
          where: { id: { in: recordIds } },
        });
      }

      if (appointmentIds.length) {
        await prisma.appointment.deleteMany({
          where: { id: { in: appointmentIds } },
        });
      }

      if (doctorProfileIds.length) {
        await prisma.doctorSchedule.deleteMany({
          where: { doctorId: { in: doctorProfileIds } },
        });

        await prisma.doctorProfile.deleteMany({
          where: { id: { in: doctorProfileIds } },
        });
      }

      if (patientProfileIds.length) {
        await prisma.patientProfile.deleteMany({
          where: { id: { in: patientProfileIds } },
        });
      }

      if (departmentIds.length) {
        await prisma.department.deleteMany({
          where: { id: { in: departmentIds } },
        });
      }

      if (userIds.length) {
        await prisma.user.deleteMany({
          where: { id: { in: userIds } },
        });
      }
    } finally {
      await app?.close();
    }
  });

  // Existing medical-records tests

  it('rejects unauthenticated access', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/medical-records')
      .expect(401);
  });

  it('allows a doctor to create and read a valid medical record', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/medical-records/${createdRecordId}`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .expect(200);

    expect(response.body.id).toBe(createdRecordId);
    expect(response.body.patientId).toBe(patientProfileId);
    expect(response.body.doctorId).toBe(doctorProfileId);
    expect(response.body.title).toBe('E2E Consultation');
  });

  it('does not allow a patient to create medical records', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/medical-records')
      .set('Authorization', `Bearer ${patientToken}`)
      .send({
        patientId: patientProfileId,
        recordType: MedicalRecordType.DIAGNOSIS,
        title: 'Unauthorized diagnosis',
        description: 'This should not be created.',
      })
      .expect(403);
  });

  it('returns only the authenticated patient records, ignoring patientId filters', async () => {
    const response = await request(app.getHttpServer())
      .get(
        `/api/v1/medical-records?patientId=${otherPatientProfileId}`,
      )
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    expect(
      response.body.every(
        (record: { patientId: string }) =>
          record.patientId === patientProfileId,
      ),
    ).toBe(true);
  });

  it('allows the owning patient to read their record', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/medical-records/${createdRecordId}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    expect(response.body.id).toBe(createdRecordId);
  });

  it('hides another patient record from a different patient', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/medical-records/${createdRecordId}`)
      .set('Authorization', `Bearer ${otherPatientToken}`)
      .expect(404);
  });

  it('hides a record from a doctor who did not author it', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/medical-records/${createdRecordId}`)
      .set('Authorization', `Bearer ${otherDoctorToken}`)
      .expect(404);
  });

  it('denies admin and receptionist access to the medical records list', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/medical-records')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/medical-records')
      .set('Authorization', `Bearer ${receptionistToken}`)
      .expect(403);
  });

  it('returns 404 for a nonexistent record', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/medical-records/${randomUUID()}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(404);
  });

  // New tests for GET /patients/:patientId/medical-records

  it('allows a patient to list their own medical records', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientProfileId}/medical-records`)
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);

    expect(
      response.body.some(
        (record: { id: string }) => record.id === createdRecordId,
      ),
    ).toBe(true);

    expect(
      response.body.every(
        (record: { patientId: string }) =>
          record.patientId === patientProfileId,
      ),
    ).toBe(true);
  });

  it('does not allow a patient to list another patient medical records', async () => {
    await request(app.getHttpServer())
      .get(
        `/api/v1/patients/${otherPatientProfileId}/medical-records`,
      )
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(404);
  });

  it('allows a doctor with a clinical relationship to list patient records', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientProfileId}/medical-records`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);

    expect(
      response.body.some(
        (record: { id: string }) => record.id === createdRecordId,
      ),
    ).toBe(true);
  });

  it('denies an unrelated doctor access to patient medical records', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientProfileId}/medical-records`)
      .set('Authorization', `Bearer ${otherDoctorToken}`)
      .expect(403);
  });

  it('denies admin and receptionist access to patient medical records', async () => {
    const endpoint =
      `/api/v1/patients/${patientProfileId}/medical-records`;

    await request(app.getHttpServer())
      .get(endpoint)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get(endpoint)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .expect(403);
  });
});

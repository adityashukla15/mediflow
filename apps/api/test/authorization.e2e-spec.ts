import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { UserRole } from '../src/generated/prisma/client.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Authorization API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const email = `authorization-${randomUUID()}@example.com`;
  const password = 'TestPassword@123';
  let accessToken: string;
  let userId: string;


  const roleEmails: string[] = [];
  const createdDepartmentIds: string[] = [];

  async function createRoleToken(role: UserRole): Promise<string> {
    const roleEmail = `role-${randomUUID()}@example.com`;
    roleEmails.push(roleEmail);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: roleEmail, password })
      .expect(201);

    await prisma.user.update({
      where: { email: roleEmail },
      data: { role },
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: roleEmail, password })
      .expect(200);

    return login.body.accessToken as string;
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

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });
    userId = user.id;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    accessToken = login.body.accessToken;
  });

  afterAll(async () => {
    try {
      if (createdDepartmentIds.length > 0) {
        // Delete schedules first because they reference doctor profiles.
        const testDoctors = await prisma.doctorProfile.findMany({
          where: { departmentId: { in: createdDepartmentIds } },
          select: { id: true },
        });

        const testDoctorIds = testDoctors.map((doctor) => doctor.id);

        if (testDoctorIds.length > 0) {
          await prisma.doctorSchedule.deleteMany({
            where: { doctorId: { in: testDoctorIds } },
          });

          await prisma.doctorProfile.deleteMany({
            where: { id: { in: testDoctorIds } },
          });
        }

        // Departments can now be deleted without doctor foreign-key conflicts.
        await prisma.department.deleteMany({
          where: { id: { in: createdDepartmentIds } },
        });
      }

      if (roleEmails.length > 0) {
        await prisma.user.deleteMany({
          where: { email: { in: roleEmails } },
        });
      }

      if (userId) {
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await app.close();
    }
  });

  it.each([
    '/api/v1/departments',
    '/api/v1/doctors',
    '/api/v1/patients/me',
  ])('rejects unauthenticated GET requests to %s', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);
  });

  it('blocks a patient from creating a department', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: `Restricted ${randomUUID()}`,
        description: 'Authorization test',
      })
      .expect(403);
  });

  it('blocks a patient from updating a department', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/departments/nonexistent-department')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Unauthorized Update' })
      .expect(403);
  });

  it('blocks a patient from creating a doctor', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/doctors')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(403);
  });

  it('blocks a patient from updating a doctor', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/doctors/nonexistent-doctor')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(403);
  });

  it('blocks a patient from setting a doctor schedule', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/doctors/nonexistent-doctor/schedules')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(403);
  });

  it('rejects patient profile requests that try to set another userId', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/patients/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        fullName: 'Test Patient',
        userId: randomUUID(),
      })
      .expect(400);
  });

  it('creates the profile for the authenticated patient only', async () => {
    const fullName = 'Authorization Test Patient';

    const response = await request(app.getHttpServer())
      .put('/api/v1/patients/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName })
      .expect(200);

    expect(response.body.userId).toBe(userId);
    expect(response.body.fullName).toBe(fullName);

    const storedProfile = await prisma.patientProfile.findUnique({
      where: { userId },
    });
    expect(storedProfile?.userId).toBe(userId);
  });

  it('allows a patient to update their existing profile', async () => {
    const updatedName = 'Updated Authorization Patient';

    const response = await request(app.getHttpServer())
      .put('/api/v1/patients/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: updatedName, phone: '9876543210' })
      .expect(200);

    expect(response.body.userId).toBe(userId);
    expect(response.body.fullName).toBe(updatedName);
    expect(response.body.phone).toBe('9876543210');

    const storedProfile = await prisma.patientProfile.findUnique({
      where: { userId },
    });

    expect(storedProfile?.fullName).toBe(updatedName);
    expect(storedProfile?.phone).toBe('9876543210');
  });

  it('does not expose another patient profile to a different user', async () => {
    const otherToken = await createRoleToken(UserRole.PATIENT);

    await request(app.getHttpServer())
      .get('/api/v1/patients/me')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  });

  it.each([
    { role: UserRole.RECEPTIONIST, label: 'receptionist' },
    { role: UserRole.ADMIN, label: 'admin' },
  ])('allows a $label to create and update a department', async ({ role }) => {
    const token = await createRoleToken(role);
    const name = `Role Test ${randomUUID()}`;

    const created = await request(app.getHttpServer())
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, description: 'E2E role test' })
      .expect(201);

    createdDepartmentIds.push(created.body.id);

    const updatedName = `Updated ${randomUUID()}`;
    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/departments/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: updatedName })
      .expect(200);

    expect(updated.body.name).toBe(updatedName);
  });

  it('does not list inactive departments', async () => {
    const department = await prisma.department.create({
      data: {
        name: `Inactive ${randomUUID()}`,
        description: 'Inactive department filtering test',
        isActive: false,
      },
    });

    createdDepartmentIds.push(department.id);

    const response = await request(app.getHttpServer())
      .get('/api/v1/departments')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.map((item: { id: string }) => item.id))
      .not.toContain(department.id);
  });


  it('does not list inactive doctors', async () => {
    const department = await prisma.department.create({
      data: {
        name: `Doctor Test Department ${randomUUID()}`,
        description: 'Doctor filtering tests',
      },
    });
    createdDepartmentIds.push(department.id);

    const doctorEmail = `inactive-doctor-${randomUUID()}@example.com`;
    roleEmails.push(doctorEmail);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: doctorEmail, password })
      .expect(201);

    const doctorUser = await prisma.user.update({
      where: { email: doctorEmail },
      data: { role: UserRole.DOCTOR },
    });

    const doctor = await prisma.doctorProfile.create({
      data: {
        userId: doctorUser.id,
        departmentId: department.id,
        fullName: 'Inactive Test Doctor',
        specialization: 'General Medicine',
        consultationFee: 500,
        isActive: false,
      },
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/doctors')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.map((item: { id: string }) => item.id))
      .not.toContain(doctor.id);
  });

  it('does not list doctors assigned to inactive departments', async () => {
    const department = await prisma.department.create({
      data: {
        name: `Inactive Doctor Department ${randomUUID()}`,
        description: 'Inactive department filtering test',
        isActive: false,
      },
    });
    createdDepartmentIds.push(department.id);

    const doctorEmail = `inactive-department-doctor-${randomUUID()}@example.com`;
    roleEmails.push(doctorEmail);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: doctorEmail, password })
      .expect(201);

    const doctorUser = await prisma.user.update({
      where: { email: doctorEmail },
      data: { role: UserRole.DOCTOR },
    });

    const doctor = await prisma.doctorProfile.create({
      data: {
        userId: doctorUser.id,
        departmentId: department.id,
        fullName: 'Inactive Department Doctor',
        specialization: 'General Medicine',
        consultationFee: 500,
      },
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/doctors')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.map((item: { id: string }) => item.id))
      .not.toContain(doctor.id);
  });

  it('does not list doctors whose user account is suspended', async () => {
    const department = await prisma.department.create({
      data: {
        name: `Suspended Doctor Department ${randomUUID()}`,
        description: 'Suspended doctor filtering test',
      },
    });
    createdDepartmentIds.push(department.id);

    const doctorEmail = `suspended-doctor-${randomUUID()}@example.com`;
    roleEmails.push(doctorEmail);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: doctorEmail, password })
      .expect(201);

    const doctorUser = await prisma.user.update({
      where: { email: doctorEmail },
      data: {
        role: UserRole.DOCTOR,
        status: 'SUSPENDED',
      },
    });

    const doctor = await prisma.doctorProfile.create({
      data: {
        userId: doctorUser.id,
        departmentId: department.id,
        fullName: 'Suspended Test Doctor',
        specialization: 'General Medicine',
        consultationFee: 500,
      },
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/doctors')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(response.body.map((item: { id: string }) => item.id))
      .not.toContain(doctor.id);
  });

});

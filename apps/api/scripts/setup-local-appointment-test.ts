import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { DayOfWeek } from '../src/generated/prisma/enums.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is missing.');
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run in production.');
}

const url = new URL(connectionString);
const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));

if (
  !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
  databaseName !== 'mediflow'
) {
  throw new Error(
    `Safety check failed: expected local mediflow database; received host=${url.hostname}, database=${databaseName}`,
  );
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const adminEmail = 'mediflow.dev.admin@example.com';
const doctorEmail = 'mediflow.dev.doctor@example.com';
const departmentName = 'General Medicine';

try {
  const [adminExists, doctorExists, departmentExists] = await Promise.all([
    prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true } }),
    prisma.user.findUnique({ where: { email: doctorEmail }, select: { id: true } }),
    prisma.department.findUnique({ where: { name: departmentName }, select: { id: true } }),
  ]);

  if (adminExists || doctorExists || departmentExists) {
    throw new Error(
      'A test account or General Medicine department already exists. Stopping without changes.',
    );
  }

  const [adminHash, doctorHash] = await Promise.all([
    argon2.hash('DevAdmin@2026Only', { type: argon2.argon2id }),
    argon2.hash('DevDoctor@2026Only', { type: argon2.argon2id }),
  ]);

  const result = await prisma.$transaction(async (tx) => {
    const admin = await tx.user.create({
      data: {
        email: adminEmail,
        passwordHash: adminHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
      select: { id: true, email: true, role: true },
    });

    const doctorUser = await tx.user.create({
      data: {
        email: doctorEmail,
        passwordHash: doctorHash,
        role: 'DOCTOR',
        status: 'ACTIVE',
      },
      select: { id: true, email: true, role: true },
    });

    const department = await tx.department.create({
      data: {
        name: departmentName,
        description: 'Local development test department.',
      },
    });

    const doctor = await tx.doctorProfile.create({
      data: {
        userId: doctorUser.id,
        departmentId: department.id,
        fullName: 'MediFlow Test Doctor',
        specialization: 'General Medicine',
        qualification: 'MBBS (test profile only)',
        consultationFee: '500.00',
      },
    });

    const schedule = await tx.doctorSchedule.createMany({
      data: [
        DayOfWeek.MONDAY,
        DayOfWeek.TUESDAY,
        DayOfWeek.WEDNESDAY,
        DayOfWeek.THURSDAY,
        DayOfWeek.FRIDAY,
      ].map((dayOfWeek: DayOfWeek) => ({
        doctorId: doctor.id,
        dayOfWeek,
        startTime: '09:00',
        endTime: '17:00',
        isActive: true,
      })),
    });

    return {
      admin,
      doctorUser,
      department: { id: department.id, name: department.name },
      doctorProfile: { id: doctor.id, fullName: doctor.fullName },
      weekdaySchedulesCreated: schedule.count,
    };
  });

  console.log('Development test setup created successfully:');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nLOCAL TEST LOGINS ONLY');
  console.log(`Admin:  ${adminEmail} / DevAdmin@2026Only`);
  console.log(`Doctor: ${doctorEmail} / DevDoctor@2026Only`);
  console.log('Do not use these credentials in production.');
} finally {
  await prisma.$disconnect();
}

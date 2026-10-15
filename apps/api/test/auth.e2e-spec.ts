
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Auth API (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const testEmails: string[] = [];
  const password = 'TestPassword@123';

  const newEmail = () => `e2e-${randomUUID()}@example.com`;

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
  });

  afterAll(async () => {
    try {
      if (testEmails.length > 0) {
        await prisma.user.deleteMany({
          where: { email: { in: testEmails } },
        });
      }
    } finally {
      await app.close();
    }
  });

  async function registerUser(email = newEmail()) {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);

    testEmails.push(email);

    return { email, response };
  }

  function getRefreshCookie(response: request.Response): string {
    const setCookie = response.headers['set-cookie'];

    const cookies = Array.isArray(setCookie)
      ? setCookie
      : setCookie
        ? [setCookie]
        : [];

    const refreshCookie = cookies.find((cookie) =>
      cookie.startsWith('mediflow_refresh='),
    );

    if (!refreshCookie) {
      throw new Error('Refresh cookie was not set');
    }

    return refreshCookie.split(';')[0];
  }

  it('registers a new patient', async () => {
    const { email, response } = await registerUser();

    expect(response.body.message).toBe('Registration successful');
    expect(response.body.user.email).toBe(email);
    expect(response.body.user.role).toBe('PATIENT');
    expect(response.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects duplicate email registration', async () => {
    const { email } = await registerUser();

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(409);
  });

  it('rejects an attempt to assign ADMIN during registration', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: newEmail(),
        password,
        role: 'ADMIN',
      })
      .expect(400);
  });

  it('rejects login with an incorrect password', async () => {
    const { email } = await registerUser();

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email,
        password: 'WrongPassword@123',
      })
      .expect(401);
  });

  it('logs in and returns an access token and refresh cookie', async () => {
    const { email } = await registerUser();

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.user.email).toBe(email);

    const refreshCookie = getRefreshCookie(response);
    expect(refreshCookie).toContain('mediflow_refresh=');
  });

  it('rejects /me without an access token', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .expect(401);
  });

  it('returns the current user with a valid access token', async () => {
    const { email } = await registerUser();

    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set(
        'Authorization',
        `Bearer ${loginResponse.body.accessToken}`,
      )
      .expect(200)
      .expect(({ body }) => {
        expect(body.email).toBe(email);
        expect(body.role).toBe('PATIENT');
        expect(body).not.toHaveProperty('passwordHash');
      });
  });

  it('rotates the refresh token and rejects the old token', async () => {
    const { email } = await registerUser();

    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const oldCookie = getRefreshCookie(loginResponse);

    const refreshResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', oldCookie)
      .expect(200);

    expect(refreshResponse.body.accessToken).toEqual(
      expect.any(String),
    );

    const newCookie = getRefreshCookie(refreshResponse);

    expect(newCookie).not.toBe(oldCookie);

    // The old refresh token must not work again.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', oldCookie)
      .expect(401);

    // The new refresh token should still work.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', newCookie)
      .expect(200);
  });

  it('logs out successfully and rejects the revoked refresh token', async () => {
    const { email } = await registerUser();

    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const refreshCookie = getRefreshCookie(loginResponse);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', refreshCookie)
      .expect(200);

    // A logged-out refresh token must be rejected.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(401);
  });
});

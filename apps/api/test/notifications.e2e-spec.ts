import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  NotificationType,
} from '../src/generated/prisma/client.js';

describe('Notifications API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const testEmails: string[] = [];
  const password = 'TestPassword@123';

  let userAId: string;
  let userBId: string;
  let tokenA: string;
  let tokenB: string;

  let userANotificationId: string;
  let userBNotificationId: string;

  const newEmail = () => `notification-e2e-${randomUUID()}@example.com`;

  async function createAndLoginUser() {
    const email = newEmail();

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);

    testEmails.push(email);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    return {
      userId: user.id,
      token: login.body.accessToken as string,
    };
  }

  async function createNotification(userId: string, title: string) {
    return prisma.notification.create({
      data: {
        userId,
        type: NotificationType.SYSTEM,
        title,
        message: `Test message for ${title}`,
      },
    });
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

    const userA = await createAndLoginUser();
    const userB = await createAndLoginUser();

    userAId = userA.userId;
    userBId = userB.userId;
    tokenA = userA.token;
    tokenB = userB.token;
  });

  beforeEach(async () => {
    // Keep every test independent of notifications from earlier tests.
    await prisma.notification.deleteMany({
      where: { userId: { in: [userAId, userBId] } },
    });

    const first = await createNotification(userAId, 'User A notification');
    await createNotification(userAId, 'User A second notification');
    const other = await createNotification(userBId, 'User B notification');

    userANotificationId = first.id;
    userBNotificationId = other.id;
  });

  afterAll(async () => {
    try {
      if (testEmails.length > 0) {
        // Related notifications and sessions are cascade-deleted.
        await prisma.user.deleteMany({
          where: { email: { in: testEmails } },
        });
      }
    } finally {
      await app.close();
    }
  });

  it('rejects listing notifications without authentication', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .expect(401);
  });

  it('returns only the authenticated user’s notifications', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(response.body.items).toHaveLength(2);
    expect(
      response.body.items.every(
        (item: { userId: string }) => item.userId === userAId,
      ),
    ).toBe(true);

    expect(response.body.pagination.total).toBe(2);
  });

  it('returns the correct unread count for each user', async () => {
    const responseA = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    const responseB = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);

    expect(responseA.body.unreadCount).toBe(2);
    expect(responseB.body.unreadCount).toBe(1);
  });

  it('supports pagination', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/notifications?page=1&limit=1')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.pagination).toMatchObject({
      page: 1,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
  });

  it('rejects invalid pagination parameters', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/notifications?page=0')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/notifications?limit=101')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);

    await request(app.getHttpServer())
      .get('/api/v1/notifications?page=abc')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);
  });

  it('allows a user to mark their own notification as read', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/notifications/${userANotificationId}/read`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(response.body.status).toBe('READ');
    expect(response.body.readAt).toBeTruthy();

    const count = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(count.body.unreadCount).toBe(1);
  });

  it('does not allow a user to read another user’s notification', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/notifications/${userBNotificationId}/read`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);

    const notification = await prisma.notification.findUniqueOrThrow({
      where: { id: userBNotificationId },
    });

    expect(notification.status).toBe('UNREAD');
    expect(notification.userId).toBe(userBId);
  });

  it('marks only the authenticated user’s notifications as read', async () => {
    const response = await request(app.getHttpServer())
      .patch('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(response.body.updatedCount).toBe(2);

    const ownUnread = await prisma.notification.count({
      where: { userId: userAId, status: 'UNREAD' },
    });

    const otherUnread = await prisma.notification.count({
      where: { userId: userBId, status: 'UNREAD' },
    });

    expect(ownUnread).toBe(0);
    expect(otherUnread).toBe(1);
  });

  it('rejects an invalid notification UUID', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/notifications/not-a-uuid/read')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);
  });
});

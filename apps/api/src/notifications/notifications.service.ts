
import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  // List only the authenticated user's notifications.
  async list(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({
        where: { userId },
      }),
    ]);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // Count unread notifications for this user.
  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: {
        userId,
        status: 'UNREAD',
      },
    });

    return { unreadCount: count };
  }

  // Mark one notification as read, scoped to its owner.
  async markAsRead(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id: notificationId,
        userId,
      },
    });

    // Return the same 404 for missing IDs and another user's IDs.
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    if (notification.status === 'READ') {
      return notification;
    }

    return this.prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: 'READ',
        readAt: new Date(),
      },
    });
  }

  // Mark all unread notifications belonging to this user.
  async markAllAsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        userId,
        status: 'UNREAD',
      },
      data: {
        status: 'READ',
        readAt: new Date(),
      },
    });

    return {
      updatedCount: result.count,
    };
  }
  async createAppointmentEventNotifications(input: {
  appointmentId: string;
  event: string;
  dedupeSuffix: string;
  recipients: Array<{
    userId: string;
    title: string;
    message: string;
  }>;
}) {
  const data = input.recipients
    .filter((recipient) => Boolean(recipient.userId))
    .map((recipient) => ({
      userId: recipient.userId,
      type: 'APPOINTMENT' as const,
      title: recipient.title,
      message: recipient.message,
      metadata: {
        appointmentId: input.appointmentId,
        event: input.event,
      },
      dedupeKey:
        `${input.appointmentId}:${input.event}:` +
        `${input.dedupeSuffix}:${recipient.userId}`,
    }));

  if (data.length === 0) {
    return { createdCount: 0 };
  }

  const result = await this.prisma.notification.createMany({
    data,
    skipDuplicates: true,
  });

  return { createdCount: result.count };
}
}

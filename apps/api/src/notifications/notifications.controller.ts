
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { NotificationsService } from './notifications.service.js';

type AuthenticatedUser = {
  id: string;
};

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  max?: number,
): number {
  if (value === undefined) return fallback;

  if (!/^\d+$/.test(value)) {
    throw new BadRequestException('Expected a positive integer');
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    (max !== undefined && parsed > max)
  ) {
    throw new BadRequestException('Query parameter is out of range');
  }

  return parsed;
}

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') pageValue?: string,
    @Query('limit') limitValue?: string,
  ) {
    const page = parsePositiveInt(pageValue, 1);
    const limit = parsePositiveInt(limitValue, 20, 100);

    return this.notificationsService.list(user.id, page, limit);
  }

  @Get('unread-count')
  getUnreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.getUnreadCount(user.id);
  }

  @Patch('read-all')
  markAllAsRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.markAllAsRead(user.id);
  }

  @Patch(':id/read')
  markAsRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markAsRead(user.id, id);
  }
}

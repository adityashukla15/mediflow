import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserRole, UserStatus } from '../generated/prisma/client.js';
import * as argon2 from 'argon2';
import {
  createHash,
  randomBytes,
} from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';

const publicUserSelect = {
  id: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private hashRefreshToken(token: string): string {
    return createHash('sha256')
      .update(token)
      .digest('hex');
  }

  private getRefreshExpiry(): Date {
    const days = Number(
      this.configService.get<string>('REFRESH_TOKEN_DAYS') ?? '7',
    );

    if (!Number.isInteger(days) || days < 1 || days > 30) {
      throw new Error('REFRESH_TOKEN_DAYS must be between 1 and 30');
    }

    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  private async createAccessToken(user: {
    id: string;
    email: string;
    role: UserRole;
  }): Promise<string> {
    return this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
  }

  private createRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private async createSession(userId: string) {
    const refreshToken = this.createRefreshToken();

    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: this.hashRefreshToken(refreshToken),
        expiresAt: this.getRefreshExpiry(),
      },
      select: {
        id: true,
        expiresAt: true,
      },
    });

    return {
      session,
      refreshToken,
    };
  }

  async register(dto: RegisterDto) {
    const email = this.normalizeEmail(dto.email);

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    try {
      const user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          role: UserRole.PATIENT,
          status: UserStatus.ACTIVE,
        },
        select: publicUserSelect,
      });

      return {
        message: 'Registration successful',
        user,
      };
    } catch (error) {
      // A concurrent request could create the same email after our
      // initial existence check. The database unique constraint is final.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'An account with this email already exists',
        );
      }

      throw error;
    }
  }

  async login(dto: LoginDto) {
    const email = this.normalizeEmail(dto.email);

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Use the same public error for a missing account and wrong password.
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await argon2.verify(
      user.passwordHash,
      dto.password,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('This account is not active');
    }

    const accessToken = await this.createAccessToken(user);
    const { session, refreshToken } = await this.createSession(user.id);

    return {
      accessToken,
      refreshToken,
      sessionExpiresAt: session.expiresAt,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    };
  }

  async refresh(refreshToken: string | undefined) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const tokenHash = this.hashRefreshToken(refreshToken);

    const session = await this.prisma.session.findUnique({
      where: {
        refreshTokenHash: tokenHash,
      },
      include: {
        user: true,
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.status !== UserStatus.ACTIVE
    ) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Rotate the refresh token. The old one is revoked atomically
    // before the replacement session is returned.
    const newRefreshToken = this.createRefreshToken();
    const newRefreshHash = this.hashRefreshToken(newRefreshToken);
    const newExpiry = this.getRefreshExpiry();

    const newSession = await this.prisma.$transaction(async (tx) => {
      const revokeResult = await tx.session.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: {
            gt: new Date(),
          },
        },
        data: {
          revokedAt: new Date(),
        },
      });

      if (revokeResult.count !== 1) {
        throw new UnauthorizedException('Refresh token already used');
      }

      return tx.session.create({
        data: {
          userId: session.userId,
          refreshTokenHash: newRefreshHash,
          expiresAt: newExpiry,
        },
        select: {
          id: true,
          expiresAt: true,
        },
      });
    });

    const accessToken = await this.createAccessToken(session.user);

    return {
      accessToken,
      refreshToken: newRefreshToken,
      sessionExpiresAt: newSession.expiresAt,
    };
  }

  async logout(refreshToken: string | undefined) {
    if (refreshToken) {
      const tokenHash = this.hashRefreshToken(refreshToken);

      await this.prisma.session.updateMany({
        where: {
          refreshTokenHash: tokenHash,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
    }

    // Idempotent: calling logout more than once is safe.
    return {
      message: 'Logged out successfully',
    };
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: publicUserSelect,
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is not available');
    }

    return user;
  }
}
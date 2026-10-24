import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { RolesGuard } from './roles.gaurd.js';
import { UserRole } from '../../generated/prisma/client.js';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: { getAllAndOverride: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    reflector = {
      getAllAndOverride: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesGuard,
        { provide: Reflector, useValue: reflector },
      ],
    }).compile();

    guard = module.get<RolesGuard>(RolesGuard);
  });

  function makeContext(user?: { id: string; role: UserRole }): ExecutionContext {
    return {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  }

  it('allows an admin when the role is permitted', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN]);

    expect(
      guard.canActivate(makeContext({ id: 'admin-1', role: UserRole.ADMIN })),
    ).toBe(true);
  });

  it('forbids a patient when the role is not permitted', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN, UserRole.RECEPTIONIST]);

    expect(() =>
      guard.canActivate(makeContext({ id: 'patient-1', role: UserRole.PATIENT })),
    ).toThrow(ForbiddenException);
  });

  it('forbids a request without an authenticated user', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN]);

    expect(() => guard.canActivate(makeContext())).toThrow(ForbiddenException);
  });
});

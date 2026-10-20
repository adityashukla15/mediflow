
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { UserRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpdatePatientProfileDto } from './dto/update-patient-profile.dto.js';

@Injectable()
export class PatientsService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async getMyProfile(userId: string) {
    const profile = await this.prisma.patientProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      throw new NotFoundException(
        'Patient profile not found. Create your profile first.',
      );
    }

    return profile;
  }

  async updateMyProfile(
    userId: string,
    dto: UpdatePatientProfileDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user || user.role !== UserRole.PATIENT) {
      throw new ForbiddenException(
        'Only patient accounts can manage patient profiles',
      );
    }

    return this.prisma.patientProfile.upsert({
      where: { userId },

      create: {
        userId,
        fullName: dto.fullName,
        dateOfBirth: dto.dateOfBirth
          ? new Date(dto.dateOfBirth)
          : null,
        phone: dto.phone ?? null,
      },

      update: {
        fullName: dto.fullName,
        dateOfBirth: dto.dateOfBirth
          ? new Date(dto.dateOfBirth)
          : null,
        phone: dto.phone ?? null,
      },
    });
  }
}

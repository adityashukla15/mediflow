
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { CreateDepartmentDto } from './dto/create-department.dto.js';
import { UpdateDepartmentDto } from './dto/update-department.dto.js';

function getPrismaErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
}

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.department.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const department = await this.prisma.department.findUnique({
      where: { id },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    return department;
  }

  async create(dto: CreateDepartmentDto) {
    try {
      return await this.prisma.department.create({
        data: {
          name: dto.name,
          description: dto.description,
        },
      });
    } catch (error: unknown) {
      if (getPrismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          'A department with this name already exists',
        );
      }

      throw error;
    }
  }

  async update(id: string, dto: UpdateDepartmentDto) {
    // Check that the department exists before attempting the update.
    await this.findOne(id);

    try {
      return await this.prisma.department.update({
        where: { id },
        data: dto,
      });
    } catch (error: unknown) {
      const code = getPrismaErrorCode(error);

      if (code === 'P2002') {
        throw new ConflictException(
          'A department with this name already exists',
        );
      }

      if (code === 'P2025') {
        throw new NotFoundException('Department not found');
      }

      throw error;
    }
  }
}

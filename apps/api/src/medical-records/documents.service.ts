
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Inject,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  UserRole,
  UserStatus,
} from '../generated/prisma/client.js';

import { PrismaService } from '../prisma/prisma.service.js';

import type { AuthenticatedUser } from '../auth/strategies/jwt.strategies.js';

import { DOCUMENT_STORAGE } from './storage/document-storage.interface.js';
import type { DocumentStorage } from './storage/document-storage.interface.js';

import type { UploadDocumentDto } from './dto/upload-document.dto.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_URL_EXPIRY_SECONDS = 60;

const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

type UploadedDocumentFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE)
    private readonly storage: DocumentStorage,
  ) {}

  private detectMimeType(buffer: Buffer): string | null {
    if (buffer.subarray(0, 5).toString() === '%PDF-') {
      return 'application/pdf';
    }

    if (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )
    ) {
      return 'image/png';
    }

    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return 'image/jpeg';
    }

    return null;
  }

  // Upload a validated document for an authorized patient.
  async upload(
    user: AuthenticatedUser,
    dto: UploadDocumentDto,
    file?: UploadedDocumentFile,
  ) {
    if (
      !file ||
      !Buffer.isBuffer(file.buffer) ||
      file.buffer.length === 0
    ) {
      throw new BadRequestException(
        'A non-empty file is required',
      );
    }

    if (file.buffer.length > MAX_FILE_BYTES) {
      throw new BadRequestException(
        'Maximum file size is 10 MB',
      );
    }

    if (!ALLOWED_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        'Only PDF, JPEG and PNG files are allowed',
      );
    }

    const detectedType = this.detectMimeType(file.buffer);

    if (!detectedType || detectedType !== file.mimetype) {
      throw new BadRequestException(
        'File content does not match the declared file type',
      );
    }

    const patient = await this.prisma.patientProfile.findUnique({
      where: { id: dto.patientId },
      select: {
        id: true,
        userId: true,
      },
    });

    if (!patient) {
      throw new NotFoundException('Patient profile not found');
    }

    if (user.role === UserRole.PATIENT) {
      if (patient.userId !== user.id) {
        throw new NotFoundException(
          'Patient profile not found',
        );
      }
    } else if (user.role === UserRole.DOCTOR) {
      const doctor = await this.prisma.doctorProfile.findFirst({
        where: {
          userId: user.id,
          isActive: true,
          user: {
            is: {
              role: UserRole.DOCTOR,
              status: UserStatus.ACTIVE,
            },
          },
          department: {
            is: { isActive: true },
          },
        },
        select: { id: true },
      });

      if (!doctor) {
        throw new NotFoundException(
          'Active doctor profile not found',
        );
      }

      const relationship =
        await this.prisma.appointment.findFirst({
          where: {
            patientId: patient.id,
            doctorId: doctor.id,
          },
          select: { id: true },
        });

      if (!relationship) {
        throw new ForbiddenException(
          'A clinical relationship with this patient is required',
        );
      }

      if (dto.recordId) {
        const record =
          await this.prisma.medicalRecord.findFirst({
            where: {
              id: dto.recordId,
              patientId: patient.id,
              doctorId: doctor.id,
            },
            select: { id: true },
          });

        if (!record) {
          throw new NotFoundException(
            'Medical record not found',
          );
        }
      }
    } else {
      throw new ForbiddenException(
        'You cannot upload clinical documents',
      );
    }

    if (user.role === UserRole.PATIENT && dto.recordId) {
      const record = await this.prisma.medicalRecord.findFirst({
        where: {
          id: dto.recordId,
          patientId: patient.id,
        },
        select: { id: true },
      });

      if (!record) {
        throw new NotFoundException(
          'Medical record not found',
        );
      }
    }

    const storageKey = randomUUID();

    const safeFileName = (file.originalname || 'document')
      .replace(/[/\\]/g, '_')
      // oxlint-disable-next-line no-control-regex -- Intentionally strip control characters from uploaded filenames.
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 255) || 'document';


    const stored = await this.storage.put(
      storageKey,
      Readable.from([file.buffer]),
      {
        contentType: detectedType,
        maxBytes: MAX_FILE_BYTES,
      },
    );

    try {
      return await this.prisma.document.create({
        data: {
          patientId: patient.id,
          uploadedById: user.id,
          recordId: dto.recordId ?? null,
          fileName: safeFileName,
          storageKey: stored.storageKey,
          mimeType: detectedType,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
        },
        // Never expose internal storage details or checksum.
        select: {
          id: true,
          patientId: true,
          uploadedById: true,
          recordId: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          createdAt: true,
        },
      });
    } catch (error) {
      // Best-effort cleanup if database metadata creation fails.
      await this.storage
        .delete(stored.storageKey)
        .catch(() => undefined);

      throw error;
    }
  }

  // List documents accessible to the authenticated user.
  async list(user: AuthenticatedUser) {
    if (user.role === UserRole.PATIENT) {
      const patient = await this.prisma.patientProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });

      if (!patient) {
        throw new NotFoundException('Patient profile not found');
      }

      return this.prisma.document.findMany({
        where: {
          patientId: patient.id,
        },
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          id: true,
          patientId: true,
          recordId: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          createdAt: true,
        },
      });
    }

    if (user.role === UserRole.DOCTOR) {
      const doctor = await this.prisma.doctorProfile.findFirst({
        where: {
          userId: user.id,
          isActive: true,
          user: {
            is: {
              role: UserRole.DOCTOR,
              status: UserStatus.ACTIVE,
            },
          },
          department: {
            is: { isActive: true },
          },
        },
        select: { id: true },
      });

      if (!doctor) {
        throw new NotFoundException(
          'Active doctor profile not found',
        );
      }

      const appointments = await this.prisma.appointment.findMany({
        where: {
          doctorId: doctor.id,
        },
        select: {
          patientId: true,
        },
        distinct: ['patientId'],
      });

      const patientIds = appointments.map(
        (appointment) => appointment.patientId,
      );

      if (patientIds.length === 0) {
        return [];
      }

      return this.prisma.document.findMany({
        where: {
          patientId: {
            in: patientIds,
          },
          OR: [
            { recordId: null },
            {
              record: {
                is: {
                  doctorId: doctor.id,
                },
              },
            },
          ],
        },
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          id: true,
          patientId: true,
          recordId: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          createdAt: true,
        },
      });
    }

    throw new ForbiddenException(
      'You do not have permission to access clinical documents',
    );
  }

  /**
   * Shared authorization check for both download methods.
   * Do not generate a URL or read the file before authorization.
   */
  private async getAuthorizedDocument(
    user: AuthenticatedUser,
    documentId: string,
  ) {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        patientId: true,
        recordId: true,
        fileName: true,
        storageKey: true,
        mimeType: true,
      },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    if (user.role === UserRole.PATIENT) {
      const patient = await this.prisma.patientProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });

      if (!patient || patient.id !== document.patientId) {
        throw new NotFoundException('Document not found');
      }
    } else if (user.role === UserRole.DOCTOR) {
      const doctor = await this.prisma.doctorProfile.findFirst({
        where: {
          userId: user.id,
          isActive: true,
          user: {
            is: {
              role: UserRole.DOCTOR,
              status: UserStatus.ACTIVE,
            },
          },
          department: {
            is: { isActive: true },
          },
        },
        select: { id: true },
      });

      if (!doctor) {
        throw new NotFoundException('Document not found');
      }

      const relationship =
        await this.prisma.appointment.findFirst({
          where: {
            patientId: document.patientId,
            doctorId: doctor.id,
          },
          select: { id: true },
        });

      if (!relationship) {
        throw new NotFoundException('Document not found');
      }

      if (document.recordId) {
        const record =
          await this.prisma.medicalRecord.findFirst({
            where: {
              id: document.recordId,
              patientId: document.patientId,
              doctorId: doctor.id,
            },
            select: { id: true },
          });

        if (!record) {
          throw new NotFoundException('Document not found');
        }
      }
    } else {
      throw new ForbiddenException(
        'You cannot access clinical documents',
      );
    }

    return document;
  }

  // Stream the document after authorization.
  async getForDownload(
    user: AuthenticatedUser,
    documentId: string,
  ) {
    const document = await this.getAuthorizedDocument(
      user,
      documentId,
    );

    return {
      fileName: document.fileName,
      mimeType: document.mimeType,
      stream: await this.storage.get(document.storageKey),
    };
  }

  // Generate a short-lived download URL after authorization.
  async getPresignedDownload(
    user: AuthenticatedUser,
    documentId: string,
  ) {
    const document = await this.getAuthorizedDocument(
      user,
      documentId,
    );

    const downloadUrl =
      await this.storage.getPresignedDownloadUrl(
        document.storageKey,
        DOWNLOAD_URL_EXPIRY_SECONDS,
      );

    return {
      downloadUrl,
      expiresInSeconds: DOWNLOAD_URL_EXPIRY_SECONDS,
      fileName: document.fileName,
      mimeType: document.mimeType,
    };
  }
}

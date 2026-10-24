
import {
  BadRequestException,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'node:stream';

import { UserRole } from '../generated/prisma/client.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

describe('DocumentsController', () => {
  let controller: DocumentsController;

  const documentsService = {
    upload: vi.fn(),
    getForDownload: vi.fn(),
  };

  const patientUser = {
    id: 'user-patient-1',
    email: 'patient@example.com',
    role: UserRole.PATIENT,
  };

  beforeEach(async () => {
    vi.resetAllMocks();

    const module: TestingModule =
      await Test.createTestingModule({
        controllers: [DocumentsController],
        providers: [
          {
            provide: DocumentsService,
            useValue: documentsService,
          },
        ],
      }).compile();

    controller = module.get<DocumentsController>(
      DocumentsController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('forwards upload arguments to the service', async () => {
    const dto = { patientId: 'patient-profile-1' };
    const file = {
      originalname: 'report.pdf',
      mimetype: 'application/pdf',
      size: 10,
      buffer: Buffer.from('%PDF-1.7 test'),
    } as Parameters<DocumentsController['upload']>[2];

    const expected = { id: 'document-1' };
    documentsService.upload.mockResolvedValue(expected);

    const result = await controller.upload(
      patientUser,
      dto,
      file,
    );

    expect(result).toEqual(expected);
    expect(documentsService.upload).toHaveBeenCalledWith(
      patientUser,
      dto,
      file,
    );
  });

  it('propagates upload validation errors from the service', async () => {
    documentsService.upload.mockRejectedValue(
      new BadRequestException('A non-empty file is required'),
    );

    await expect(
      controller.upload(
        patientUser,
        { patientId: 'patient-profile-1' },
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a StreamableFile for an authorized download', async () => {
    const stream = Readable.from(['test file content']);

    documentsService.getForDownload.mockResolvedValue({
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      stream,
    });

    const response = {
      setHeader: vi.fn(),
    };

    const result = await controller.download(
      patientUser,
      'document-1',
      response as never,
    );

    expect(result).toBeInstanceOf(StreamableFile);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Content-Type-Options',
      'nosniff',
    );
  });

  it('propagates not-found errors for inaccessible documents', async () => {
    documentsService.getForDownload.mockRejectedValue(
      new NotFoundException('Document not found'),
    );

    await expect(
      controller.download(
        patientUser,
        'document-1',
        { setHeader: vi.fn() } as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});


import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'node:stream';

import {
  UserRole,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentsService } from './documents.service.js';
import {
  DOCUMENT_STORAGE,
} from './storage/document-storage.interface.js';

describe('DocumentsService', () => {
  let service: DocumentsService;

  const prisma = {
    patientProfile: {
      findUnique: vi.fn(),
    },
    doctorProfile: {
      findFirst: vi.fn(),
    },
    appointment: {
      findFirst: vi.fn(),
    },
    medicalRecord: {
      findFirst: vi.fn(),
    },
    document: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
  };

  const storage = {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  };

  const patientUser = {
    id: 'user-patient-1',
    email: 'patient@example.com',
    role: UserRole.PATIENT,
  };

  const patientProfile = {
    id: 'patient-profile-1',
    userId: patientUser.id,
  };

  const fileBuffer = Buffer.from('%PDF-1.7 test document');

  const uploadedFile = {
    originalname: 'report.pdf',
    mimetype: 'application/pdf',
    size: fileBuffer.length,
    buffer: fileBuffer,
  };

  const storedDocument = {
    storageKey: 'storage-key-1',
    sizeBytes: fileBuffer.length,
    checksum: 'a'.repeat(64),
  };

  const document = {
    id: 'document-1',
    patientId: patientProfile.id,
    uploadedById: patientUser.id,
    recordId: null,
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: fileBuffer.length,
    checksum: 'a'.repeat(64),
    createdAt: new Date(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();

    const module: TestingModule =
      await Test.createTestingModule({
        providers: [
          DocumentsService,
          { provide: PrismaService, useValue: prisma },
          { provide: DOCUMENT_STORAGE, useValue: storage },
        ],
      }).compile();

    service = module.get<DocumentsService>(DocumentsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('allows a patient to upload a valid PDF to their own profile', async () => {
    prisma.patientProfile.findUnique.mockResolvedValue(
      patientProfile,
    );
    storage.put.mockResolvedValue(storedDocument);
    prisma.document.create.mockResolvedValue(document);

    const result = await service.upload(
      patientUser,
      { patientId: patientProfile.id },
      uploadedFile,
    );

    expect(result).toEqual(document);

    expect(storage.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Readable),
      {
        contentType: 'application/pdf',
        maxBytes: 10 * 1024 * 1024,
      },
    );

    expect(prisma.document.create).toHaveBeenCalledWith({
      data: {
        patientId: patientProfile.id,
        uploadedById: patientUser.id,
        recordId: null,
        fileName: 'report.pdf',
        storageKey: storedDocument.storageKey,
        mimeType: 'application/pdf',
        sizeBytes: storedDocument.sizeBytes,
        checksum: storedDocument.checksum,
      },
      select: expect.any(Object),
    });
  });

  it('rejects an upload when no file is provided', async () => {
    await expect(
      service.upload(
        patientUser,
        { patientId: patientProfile.id },
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it('rejects a file with an unsupported MIME type', async () => {
    await expect(
      service.upload(
        patientUser,
        { patientId: patientProfile.id },
        {
          ...uploadedFile,
          mimetype: 'text/plain',
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects a file whose content does not match its MIME type', async () => {
    const fakePdf = Buffer.from('This is not a PDF');

    await expect(
      service.upload(
        patientUser,
        { patientId: patientProfile.id },
        {
          ...uploadedFile,
          buffer: fakePdf,
          size: fakePdf.length,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects a patient uploading to another patient profile', async () => {
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: patientProfile.id,
      userId: 'another-user-id',
    });

    await expect(
      service.upload(
        patientUser,
        { patientId: patientProfile.id },
        uploadedFile,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it('deletes the stored file if saving document metadata fails', async () => {
    prisma.patientProfile.findUnique.mockResolvedValue(
      patientProfile,
    );
    storage.put.mockResolvedValue(storedDocument);
    prisma.document.create.mockRejectedValue(
      new Error('Database write failed'),
    );
    storage.delete.mockResolvedValue(undefined);

    await expect(
      service.upload(
        patientUser,
        { patientId: patientProfile.id },
        uploadedFile,
      ),
    ).rejects.toThrow('Database write failed');

    expect(storage.delete).toHaveBeenCalledWith(
      storedDocument.storageKey,
    );
  });

  it('allows a patient to download their own document', async () => {
    const stream = Readable.from([fileBuffer]);

    prisma.document.findUnique.mockResolvedValue({
      ...document,
      storageKey: storedDocument.storageKey,
    });
    prisma.patientProfile.findUnique.mockResolvedValue(
      patientProfile,
    );
    storage.get.mockResolvedValue(stream);

    const result = await service.getForDownload(
      patientUser,
      document.id,
    );

    expect(result).toEqual({
      fileName: document.fileName,
      mimeType: document.mimeType,
      stream,
    });

    expect(storage.get).toHaveBeenCalledWith(
      storedDocument.storageKey,
    );
  });

  it('does not reveal a document belonging to another patient', async () => {
    prisma.document.findUnique.mockResolvedValue({
      ...document,
      storageKey: storedDocument.storageKey,
    });
    prisma.patientProfile.findUnique.mockResolvedValue({
      id: 'different-patient-profile',
    });

    await expect(
      service.getForDownload(patientUser, document.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(storage.get).not.toHaveBeenCalled();
  });

  it('returns not found when the document does not exist', async () => {
    prisma.document.findUnique.mockResolvedValue(null);

    await expect(
      service.getForDownload(patientUser, 'missing-document'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(storage.get).not.toHaveBeenCalled();
  });
});

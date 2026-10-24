
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { DOCUMENT_STORAGE } from '../src/medical-records/storage/document-storage.interface.js';
import type { DocumentStorage } from '../src/medical-records/storage/document-storage.interface.js';

describe('Medical Documents API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: DocumentStorage;
  let storageDir: string;

  const previousStorageDir =
    process.env.MEDICAL_DOCUMENT_STORAGE_DIR;

  const password = 'TestPassword@123';
  const patientIds: string[] = [];
  const patientProfileIds: string[] = [];

  let patientProfileId: string;
  let otherPatientProfileId: string;
  let patientToken: string;
  let otherPatientToken: string;
  let uploadedDocumentId: string;

  const pdfBuffer = Buffer.from(
    '%PDF-1.4\nMediFlow E2E document\n%%EOF\n',
  );

  async function createPatient() {
    const email = `documents-e2e-${randomUUID()}@example.com`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password })
      .expect(201);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });

    patientIds.push(user.id);

    const profile = await prisma.patientProfile.create({
      data: {
        userId: user.id,
        fullName: 'Documents E2E Patient',
      },
    });

    patientProfileIds.push(profile.id);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    return {
      profileId: profile.id,
      token: login.body.accessToken as string,
    };
  }

  beforeAll(async () => {
    storageDir = await mkdtemp(
      join(tmpdir(), 'mediflow-documents-e2e-'),
    );

    process.env.MEDICAL_DOCUMENT_STORAGE_DIR = storageDir;

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
    storage = app.get<DocumentStorage>(DOCUMENT_STORAGE);

    const patient = await createPatient();
    patientProfileId = patient.profileId;
    patientToken = patient.token;

    const otherPatient = await createPatient();
    otherPatientProfileId = otherPatient.profileId;
    otherPatientToken = otherPatient.token;
  });

  afterAll(async () => {
    try {
      if (patientProfileIds.length > 0) {
        const documents = await prisma.document.findMany({
          where: {
            patientId: { in: patientProfileIds },
          },
          select: {
            storageKey: true,
          },
        });

        // Delete stored files/objects before deleting metadata.
        for (const document of documents) {
          try {
            await storage.delete(document.storageKey);
          } catch (error) {
            console.error(
              'Failed to clean up E2E document object:',
              document.storageKey,
              error,
            );
          }
        }

        await prisma.document.deleteMany({
          where: {
            patientId: { in: patientProfileIds },
          },
        });
      }

      if (patientIds.length > 0) {
        await prisma.patientProfile.deleteMany({
          where: { userId: { in: patientIds } },
        });

        await prisma.user.deleteMany({
          where: { id: { in: patientIds } },
        });
      }
    } finally {
      try {
        await app?.close();
      } finally {
        if (previousStorageDir === undefined) {
          delete process.env.MEDICAL_DOCUMENT_STORAGE_DIR;
        } else {
          process.env.MEDICAL_DOCUMENT_STORAGE_DIR =
            previousStorageDir;
        }

        if (storageDir) {
          await rm(storageDir, {
            recursive: true,
            force: true,
          });
        }
      }
    }
  });

  it('rejects document upload without authentication', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/medical-records/documents')
      .field('patientId', randomUUID())
      .attach('file', pdfBuffer, {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      })
      .expect(401);
  });

  it('uploads a valid PDF for the authenticated patient', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/medical-records/documents')
      .set('Authorization', `Bearer ${patientToken}`)
      .field('patientId', patientProfileId)
      .attach('file', pdfBuffer, {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(response.body.id).toEqual(expect.any(String));
    expect(response.body.patientId).toBe(patientProfileId);
    expect(response.body.fileName).toBe('report.pdf');
    expect(response.body.mimeType).toBe('application/pdf');
    expect(response.body.sizeBytes).toBe(pdfBuffer.length);

    uploadedDocumentId = response.body.id;
  });

  it('rejects a file whose content does not match its MIME type', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/medical-records/documents')
      .set('Authorization', `Bearer ${patientToken}`)
      .field('patientId', patientProfileId)
      .attach('file', Buffer.from('not a PDF'), {
        filename: 'fake.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
  });

  it('rejects attempts to upload for another patient', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/medical-records/documents')
      .set('Authorization', `Bearer ${patientToken}`)
      .field('patientId', otherPatientProfileId)
      .attach('file', pdfBuffer, {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      })
      .expect(404);
  });

  it('rejects document listing without authentication', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/medical-records/documents')
      .expect(401);
  });

  it('lists documents belonging to the authenticated patient', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/medical-records/documents')
      .set('Authorization', `Bearer ${patientToken}`);

    // Temporary debugging: inspect the actual 400 response.
    console.log('PATIENT LIST STATUS:', response.status);
    console.log(
      'PATIENT LIST BODY:',
      JSON.stringify(response.body, null, 2),
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);

    const document = response.body.find(
      (item: { id: string }) => item.id === uploadedDocumentId,
    );

    expect(document).toBeDefined();
    expect(document.patientId).toBe(patientProfileId);
    expect(document.fileName).toBe('report.pdf');
    expect(document.mimeType).toBe('application/pdf');

    expect(document).not.toHaveProperty('storageKey');
    expect(document).not.toHaveProperty('checksum');
  });

  it('does not list another patient document', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/medical-records/documents')
      .set('Authorization', `Bearer ${otherPatientToken}`);

    // Temporary debugging: inspect the actual 400 response.
    console.log('OTHER PATIENT LIST STATUS:', response.status);
    console.log(
      'OTHER PATIENT LIST BODY:',
      JSON.stringify(response.body, null, 2),
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);

    expect(
      response.body.some(
        (item: { id: string }) => item.id === uploadedDocumentId,
      ),
    ).toBe(false);
  });

  it('downloads the uploaded PDF for its owner', async () => {
    expect(uploadedDocumentId).toEqual(expect.any(String));

    const response = await request(app.getHttpServer())
      .get(
        `/api/v1/medical-records/documents/${uploadedDocumentId}`,
      )
      .set('Authorization', `Bearer ${patientToken}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });

        res.on('end', () => {
          callback(null, Buffer.concat(chunks));
        });

        res.on('error', callback);
      })
      .expect(200);

    expect(response.headers['content-type']).toMatch(
      /application\/pdf/,
    );

    expect(response.headers['content-disposition']).toContain(
      'attachment;',
    );

    expect(response.headers['content-disposition']).toContain(
      'report.pdf',
    );

    expect(response.headers['cache-control']).toBe(
      'private, no-store',
    );

    expect(response.headers['x-content-type-options']).toBe(
      'nosniff',
    );

    expect(Buffer.from(response.body).equals(pdfBuffer)).toBe(true);
  });

  it('does not allow another patient to download the document', async () => {
    expect(uploadedDocumentId).toEqual(expect.any(String));

    await request(app.getHttpServer())
      .get(
        `/api/v1/medical-records/documents/${uploadedDocumentId}`,
      )
      .set('Authorization', `Bearer ${otherPatientToken}`)
      .expect(404);
  });

  it('rejects unauthenticated document downloads', async () => {
    await request(app.getHttpServer())
      .get(
        `/api/v1/medical-records/documents/${randomUUID()}`,
      )
      .expect(401);
  });

  it('returns a presigned download URL for the document owner', async () => {
    expect(uploadedDocumentId).toEqual(expect.any(String));

    const response = await request(app.getHttpServer())
      .get(`/api/v1/documents/${uploadedDocumentId}/download`)
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    expect(response.body.downloadUrl).toEqual(expect.any(String));
    expect(response.body.downloadUrl).toContain('127.0.0.1:9000');
    expect(response.body.expiresInSeconds).toBe(60);
    expect(response.body.fileName).toBe('report.pdf');
    expect(response.body.mimeType).toBe('application/pdf');
  });

  it('does not return a presigned URL to another patient', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/documents/${uploadedDocumentId}/download`)
      .set('Authorization', `Bearer ${otherPatientToken}`)
      .expect(404);
  });

  it('rejects unauthenticated presigned download requests', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/documents/${uploadedDocumentId}/download`)
      .expect(401);
  });

  it('downloads the original PDF using the presigned URL', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/documents/${uploadedDocumentId}/download`)
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);

    const downloadUrl = response.body.downloadUrl as string;

    const downloadResponse = await fetch(downloadUrl);

    expect(downloadResponse.status).toBe(200);

    const downloadedBuffer = Buffer.from(
      await downloadResponse.arrayBuffer(),
    );

    expect(downloadedBuffer.equals(pdfBuffer)).toBe(true);
  });
});


import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalDocumentStorageService } from './local-document-storage.service.js';

describe('LocalDocumentStorageService', () => {
  let storage: LocalDocumentStorageService;
  let tempDirectory: string;
  let previousStorageDirectory: string | undefined;

  beforeEach(async () => {
    previousStorageDirectory = process.env.MEDICAL_DOCUMENT_STORAGE_DIR;
    tempDirectory = await mkdtemp(join(tmpdir(), 'mediflow-documents-'));
    process.env.MEDICAL_DOCUMENT_STORAGE_DIR = tempDirectory;

    storage = new LocalDocumentStorageService();
  });

  afterEach(async () => {
    if (previousStorageDirectory === undefined) {
      delete process.env.MEDICAL_DOCUMENT_STORAGE_DIR;
    } else {
      process.env.MEDICAL_DOCUMENT_STORAGE_DIR = previousStorageDirectory;
    }

    await rm(tempDirectory, { recursive: true, force: true });
  });

  it('stores a document and returns its size and SHA-256 checksum', async () => {
    const content = Buffer.from('MediFlow test document');
    const storageKey = randomUUID();

    const result = await storage.put(
      storageKey,
      Readable.from([content]),
      { contentType: 'application/pdf', maxBytes: 1024 },
    );

    expect(result).toEqual({
      storageKey,
      sizeBytes: content.length,
      checksum: createHash('sha256').update(content).digest('hex'),
    });

    const savedFile = await readFile(join(tempDirectory, storageKey));
    expect(savedFile).toEqual(content);
  });

  it('retrieves a stored document', async () => {
    const content = Buffer.from('Private medical document');
    const storageKey = randomUUID();

    await storage.put(storageKey, Readable.from([content]), {
      contentType: 'application/pdf',
      maxBytes: 1024,
    });

    const stream = await storage.get(storageKey);
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks)).toEqual(content);
  });

  it('rejects documents exceeding the configured size limit', async () => {
    const storageKey = randomUUID();

    await expect(
      storage.put(
        storageKey,
        Readable.from([Buffer.from('123456')]),
        { contentType: 'application/pdf', maxBytes: 5 },
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(readFile(join(tempDirectory, storageKey))).rejects.toThrow();
  });

  it('rejects invalid storage keys', async () => {
    await expect(
      storage.put('invalid-key', Readable.from(['data']), {
        contentType: 'application/pdf',
        maxBytes: 1024,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(storage.get('../outside-file')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns not found for a missing document', async () => {
    await expect(storage.get(randomUUID())).rejects.toThrow(
      NotFoundException,
    );
  });

  it('deletes a stored document', async () => {
    const storageKey = randomUUID();

    await storage.put(
      storageKey,
      Readable.from([Buffer.from('temporary document')]),
      { contentType: 'application/pdf', maxBytes: 1024 },
    );

    await storage.delete(storageKey);

    await expect(readFile(join(tempDirectory, storageKey))).rejects.toThrow();
    await expect(storage.get(storageKey)).rejects.toThrow(NotFoundException);
  });
});

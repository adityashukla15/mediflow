import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3DocumentStorageService } from './s3-document-storage.service.js';

const runIntegration = process.env.RUN_S3_INTEGRATION === '1';
const integration = runIntegration ? describe : describe.skip;

integration('Silo S3 integration', () => {
  let storage: S3DocumentStorageService;
  const keys: string[] = [];

  beforeAll(() => {
    storage = new S3DocumentStorageService();
  });

  afterAll(async () => {
    for (const key of keys) {
      await storage.delete(key).catch(() => undefined);
    }
  });

  it('uploads, downloads and deletes a document in the private bucket', async () => {
    const key = randomUUID();
    const original = Buffer.from('MediFlow Silo integration test');
    keys.push(key);

    const uploaded = await storage.put(
      key,
      Readable.from([original]),
      { contentType: 'application/pdf', maxBytes: 1024 },
    );

    expect(uploaded.sizeBytes).toBe(original.length);
    expect(uploaded.checksum).toMatch(/^[a-f0-9]{64}$/);

    const stream = await storage.get(key);
    const chunks: Buffer[] = [];

    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks).equals(original)).toBe(true);

    await storage.delete(key);
    keys.splice(keys.indexOf(key), 1);

    await expect(storage.get(key)).rejects.toThrow();
  });
});
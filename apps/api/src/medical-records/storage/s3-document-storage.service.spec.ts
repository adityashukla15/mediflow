import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { BadRequestException, NotFoundException } from '@nestjs/common';

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class MockCommand {
    input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  return {
    S3Client: class {
      send = sendMock;
      constructor(_config: unknown) {}
    },
    PutObjectCommand: MockCommand,
    GetObjectCommand: MockCommand,
    DeleteObjectCommand: MockCommand,
  };
});

import { S3DocumentStorageService } from './s3-document-storage.service.js';

const KEY = '12345678-1234-4234-8234-123456789abc';

describe('S3DocumentStorageService', () => {
  let service: S3DocumentStorageService;

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.S3_ENDPOINT = 'http://127.0.0.1:9000';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_BUCKET = 'mediflow-private-docs';
    process.env.S3_ACCESS_KEY_ID = 'test-access-key';
    process.env.S3_SECRET_ACCESS_KEY = 'test-secret-key';

    sendMock.mockResolvedValue({});
    service = new S3DocumentStorageService();
  });

  it('uploads a document and returns its size and SHA-256 checksum', async () => {
    const content = Buffer.from('MediFlow test document');

    const result = await service.put(
      KEY,
      Readable.from([content]),
      { contentType: 'application/pdf', maxBytes: 1024 },
    );

    expect(result.storageKey).toBe(KEY);
    expect(result.sizeBytes).toBe(content.length);
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const command = sendMock.mock.calls[0][0];
    expect(command.input).toMatchObject({
      Bucket: 'mediflow-private-docs',
      Key: KEY,
      ContentType: 'application/pdf',
      ContentLength: content.length,
    });
    expect(command.input.Metadata.sha256).toBe(result.checksum);
  });

  it('rejects content exceeding the maximum size', async () => {
    await expect(
      service.put(
        KEY,
        Readable.from([Buffer.from('this is too long')]),
        { contentType: 'application/pdf', maxBytes: 4 },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid storage key', async () => {
    await expect(
      service.get('../private-file'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('retrieves the document stream', async () => {
    sendMock.mockResolvedValueOnce({
      Body: Readable.from([Buffer.from('downloaded document')]),
    });

    const stream = await service.get(KEY);
    const chunks: Buffer[] = [];

    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks).toString()).toBe('downloaded document');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('maps a missing S3 object to NotFoundException', async () => {
    sendMock.mockRejectedValueOnce({
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });

    await expect(service.get(KEY)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes an object', async () => {
    await expect(service.delete(KEY)).resolves.toBeUndefined();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].input).toMatchObject({
      Bucket: 'mediflow-private-docs',
      Key: KEY,
    });
  });
});

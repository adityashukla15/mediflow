
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';

import type {
  DocumentStorage,
  StoredDocument,
} from './document-storage.interface.js';

const ABSOLUTE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PRESIGNED_URL_EXPIRY_SECONDS = 60;

@Injectable()
export class S3DocumentStorageService implements DocumentStorage {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor() {
    const endpoint = process.env.S3_ENDPOINT;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

    this.bucket = process.env.S3_BUCKET ?? '';

    if (
      !endpoint ||
      !accessKeyId ||
      !secretAccessKey ||
      !this.bucket
    ) {
      throw new Error(
        'S3 storage configuration is incomplete. Check S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_BUCKET.',
      );
    }

    this.client = new S3Client({
      endpoint,
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  private validateKey(storageKey: string): void {
    if (!/^[a-f0-9-]{36}$/i.test(storageKey)) {
      throw new NotFoundException('Document not found');
    }
  }

  async put(
    storageKey: string,
    content: NodeJS.ReadableStream,
    options: {
      contentType: string;
      maxBytes: number;
    },
  ): Promise<StoredDocument> {
    this.validateKeyForUpload(storageKey);

    const maxBytes = Math.min(
      options.maxBytes,
      ABSOLUTE_MAX_BYTES,
    );

    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new BadRequestException('Invalid maximum file size');
    }

    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let sizeBytes = 0;

    try {
      for await (const chunk of content as AsyncIterable<
        Buffer | string
      >) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);

        sizeBytes += buffer.length;

        if (sizeBytes > maxBytes) {
          throw new BadRequestException(
            'Document exceeds the permitted file size',
          );
        }

        hash.update(buffer);
        chunks.push(buffer);
      }

      if (sizeBytes === 0) {
        throw new BadRequestException(
          'Empty documents are not allowed',
        );
      }

      const body = Buffer.concat(chunks);
      const checksum = hash.digest('hex');

      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          Body: body,
          ContentLength: sizeBytes,
          ContentType: options.contentType,
          Metadata: {
            sha256: checksum,
          },
        }),
      );

      return {
        storageKey,
        sizeBytes,
        checksum,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new InternalServerErrorException(
        'Unable to store document',
      );
    }
  }

  private validateKeyForUpload(storageKey: string): void {
    if (!/^[a-f0-9-]{36}$/i.test(storageKey)) {
      throw new BadRequestException('Invalid storage key');
    }
  }

  async get(
    storageKey: string,
  ): Promise<NodeJS.ReadableStream> {
    this.validateKey(storageKey);

    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
        }),
      );

      if (!result.Body) {
        throw new NotFoundException('Document not found');
      }

      return result.Body as NodeJS.ReadableStream;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        (typeof error === 'object' &&
          error !== null &&
          '$metadata' in error &&
          (error as {
            $metadata?: { httpStatusCode?: number };
          }).$metadata?.httpStatusCode === 404)
      ) {
        throw new NotFoundException('Document not found');
      }

      throw new InternalServerErrorException(
        'Unable to retrieve document',
      );
    }
  }

  async getPresignedDownloadUrl(
    storageKey: string,
    expiresInSeconds = MAX_PRESIGNED_URL_EXPIRY_SECONDS,
  ): Promise<string> {
    this.validateKey(storageKey);

    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > MAX_PRESIGNED_URL_EXPIRY_SECONDS
    ) {
      throw new BadRequestException(
        'URL expiry must be between 1 and 60 seconds',
      );
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
      });

      return await getSignedUrl(this.client, command, {
        expiresIn: expiresInSeconds,
      });
    } catch {
      throw new InternalServerErrorException(
        'Unable to generate document download URL',
      );
    }
  }

  async delete(storageKey: string): Promise<void> {
    this.validateKey(storageKey);

    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
        }),
      );
    } catch {
      throw new InternalServerErrorException(
        'Unable to delete document',
      );
    }
  }
}


import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { createHash, randomUUID } from 'node:crypto';

import {
  createReadStream,
  createWriteStream,
} from 'node:fs';

import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type {
  DocumentStorage,
  StoredDocument,
} from './document-storage.interface.js';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

@Injectable()
export class LocalDocumentStorageService implements DocumentStorage {
  private readonly root = resolve(
    process.env.MEDICAL_DOCUMENT_STORAGE_DIR ??
      './private-medical-documents',
  );

  async put(
    storageKey: string,
    content: NodeJS.ReadableStream,
    options: {
      contentType: string;
      maxBytes: number;
    },
  ): Promise<StoredDocument> {
    // Never allow callers to choose a path.
    if (!/^[a-f0-9-]{36}$/i.test(storageKey)) {
      throw new BadRequestException('Invalid storage key');
    }

    const maxBytes = Math.min(
      options.maxBytes,
      MAX_DOCUMENT_BYTES,
    );

    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new BadRequestException('Invalid maximum file size');
    }

    const directory = this.root;
    const target = resolve(directory, storageKey);

    if (!target.startsWith(`${directory}${sep}`)) {
      throw new BadRequestException('Invalid storage path');
    }

    await mkdir(directory, {
      recursive: true,
      mode: 0o700,
    });

    const hash = createHash('sha256');
    let sizeBytes = 0;
    let fileCreated = false;

    const meter = new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);

        sizeBytes += buffer.length;

        if (sizeBytes > maxBytes) {
          callback(
            new BadRequestException(
              'Document exceeds the permitted file size',
            ),
          );
          return;
        }

        hash.update(buffer);
        callback(null, buffer);
      },
    });

    try {
      const output = createWriteStream(target, {
        flags: 'wx',
        mode: 0o600,
      });

      fileCreated = true;

      await pipeline(
        content as NodeJS.ReadableStream &
          AsyncIterable<Buffer>,
        meter,
        output,
      );

      if (sizeBytes === 0) {
        await rm(target, { force: true });

        throw new BadRequestException(
          'Empty documents are not allowed',
        );
      }

      return {
        storageKey,
        sizeBytes,
        checksum: hash.digest('hex'),
      };
    } catch (error) {
      if (fileCreated) {
        await rm(target, { force: true }).catch(
          () => undefined,
        );
      }

      throw error;
    }
  }

  async get(
    storageKey: string,
  ): Promise<NodeJS.ReadableStream> {
    if (!/^[a-f0-9-]{36}$/i.test(storageKey)) {
      throw new NotFoundException('Document not found');
    }

    const target = resolve(this.root, storageKey);

    try {
      const info = await stat(target);

      if (!info.isFile()) {
        throw new NotFoundException('Document not found');
      }

      return createReadStream(target);
    } catch {
      throw new NotFoundException('Document not found');
    }
  }

  async getPresignedDownloadUrl(
    _storageKey: string,
    _expiresInSeconds = 60,
  ): Promise<string> {
    throw new ServiceUnavailableException(
      'Presigned downloads require S3-compatible storage',
    );
  }

  async delete(storageKey: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(storageKey)) {
      throw new NotFoundException('Document not found');
    }

    const target = resolve(this.root, storageKey);

    try {
      await rm(target);
    } catch {
      throw new NotFoundException('Document not found');
    }
  }

  static createStorageKey(): string {
    return randomUUID();
  }
}

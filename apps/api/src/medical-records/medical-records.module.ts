
import { Module, type Provider } from '@nestjs/common';

import { MedicalRecordsController } from './medical-records.controller.js';
import {
  DocumentsController,
  DocumentsDownloadController,
} from './documents.controller.js';

import { MedicalRecordsService } from './medical-records.service.js';
import { DocumentsService } from './documents.service.js';

import { DOCUMENT_STORAGE } from './storage/document-storage.interface.js';
import { LocalDocumentStorageService } from './storage/local-document-storage.service.js';
import { S3DocumentStorageService } from './storage/s3-document-storage.service.js';

const storageProviders: Provider[] =
  process.env.STORAGE_PROVIDER === 's3'
    ? [
        S3DocumentStorageService,
        {
          provide: DOCUMENT_STORAGE,
          useExisting: S3DocumentStorageService,
        },
      ]
    : [
        LocalDocumentStorageService,
        {
          provide: DOCUMENT_STORAGE,
          useExisting: LocalDocumentStorageService,
        },
      ];

@Module({
  controllers: [
  DocumentsController,
  DocumentsDownloadController,
  MedicalRecordsController,
],
  providers: [
    MedicalRecordsService,
    DocumentsService,
    ...storageProviders,
  ],
  exports: [
    MedicalRecordsService,
    DocumentsService,
    DOCUMENT_STORAGE,
  ],
})
export class MedicalRecordsModule {}

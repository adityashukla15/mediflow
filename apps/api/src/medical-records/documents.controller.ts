
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { Readable } from 'node:stream';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.gaurd.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorators.js';
import { UserRole } from '../generated/prisma/client.js';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategies.js';

import { UploadDocumentDto } from './dto/upload-document.dto.js';
import { DocumentsService } from './documents.service.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PATIENT, UserRole.DOCTOR)
@Controller('medical-records/documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_FILE_BYTES,
        files: 1,
      },
    }),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UploadDocumentDto,
    @UploadedFile()
    file?: Parameters<DocumentsService['upload']>[2],
  ) {
    return this.documentsService.upload(user, dto, file);
  }

  /**
   * List documents accessible to the authenticated patient or doctor.
   * Returns metadata only, never storage keys or checksums.
   */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.list(user);
  }

  /**
   * Stream a document after checking access permissions.
   */
  @Get(':id')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const document =
      await this.documentsService.getForDownload(user, id);

    const safeFileName = document.fileName.replace(
      /[^a-zA-Z0-9._ -]/g,
      '_',
    );

    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    return new StreamableFile(
      document.stream as Readable,
      {
        type: document.mimeType,
        disposition: `attachment; filename="${safeFileName}"`,
      },
    );
  }
}

/**
 * Separate controller because the presigned download route
 * must be rooted at /documents, not /medical-records/documents.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PATIENT, UserRole.DOCTOR)
@Controller('documents')
export class DocumentsDownloadController {
  constructor(
    private readonly documentsService: DocumentsService,
  ) {}

  @Get(':documentId/download')
  getPresignedDownload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.documentsService.getPresignedDownload(
      user,
      documentId,
    );
  }
}

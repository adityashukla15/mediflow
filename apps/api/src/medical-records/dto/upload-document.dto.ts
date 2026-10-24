
import {
  IsOptional,
  IsUUID,
} from 'class-validator';

export class UploadDocumentDto {
  @IsUUID()
  patientId!: string;

  @IsOptional()
  @IsUUID()
  recordId?: string;
}

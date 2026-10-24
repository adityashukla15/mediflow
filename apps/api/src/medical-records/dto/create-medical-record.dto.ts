import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { MedicalRecordType } from '../../generated/prisma/client.js';

export class CreateMedicalRecordDto {
  @IsUUID()
  patientId!: string;

  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @IsEnum(MedicalRecordType)
  recordType!: MedicalRecordType;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  description!: string;
}
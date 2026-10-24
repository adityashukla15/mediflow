import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PrescriptionItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  medicineName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  strength?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  dosage!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  frequency!: string;

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  instructions?: string;
}

export class CreatePrescriptionDto {
  @IsUUID()
  patientId!: string;

  @IsUUID()
  appointmentId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemDto)
  items!: PrescriptionItemDto[];
}
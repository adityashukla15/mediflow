
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateLabReportDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  testName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  labName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  resultSummary?: string;

  @IsOptional()
  @IsUUID()
  documentId?: string;

  @IsOptional()
  @IsIn(['PENDING', 'COMPLETED', 'CANCELLED'])
  status?: 'PENDING' | 'COMPLETED' | 'CANCELLED';

  @IsOptional()
  @IsDateString()
  reportedAt?: string;
}

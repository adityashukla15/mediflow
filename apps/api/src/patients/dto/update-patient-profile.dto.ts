
import {
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdatePatientProfileDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  fullName!: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

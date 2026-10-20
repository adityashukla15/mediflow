
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateDoctorDto {
  @IsUUID()
  userId!: string;

  @IsUUID()
  departmentId!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  specialization!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  qualification?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  consultationFee!: number;
}

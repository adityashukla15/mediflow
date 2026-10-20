
import {
  IsEnum,
  IsString,
  Matches,
} from 'class-validator';
import { DayOfWeek } from '../../generated/prisma/client.js';

export class SetDoctorScheduleDto {
  @IsEnum(DayOfWeek)
  dayOfWeek!: DayOfWeek;

  @IsString()
  @Matches(
    /^(?:[01]\d|2[0-3]):[0-5]\d$/,
    { message: 'startTime must be in HH:mm format (24-hour clock)' },
  )
  startTime!: string;

  @IsString()
  @Matches(
    /^(?:[01]\d|2[0-3]):[0-5]\d$/,
    { message: 'endTime must be in HH:mm format (24-hour clock)' },
  )
  endTime!: string;
}

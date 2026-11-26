import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class InitiateUploadDto {
  /** Original file name, kept for the download `Content-Disposition`. */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName: string;

  /** Video title. Defaults to `fileName` without its extension. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title?: string;

  /** Declared size in bytes. The maximum is a domain rule (`VIDEO_TOO_LARGE`). */
  @IsInt()
  @Min(1)
  sizeBytes: number;

  /** Declared MIME type of the video, e.g. `video/mp4`. */
  @IsString()
  @MaxLength(127)
  @Matches(/^video\/[\w.+-]+$/)
  mimeType: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { PartUrlDto } from './part-url.dto';

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  videoId: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', minLength: 11, maxLength: 11 })
  publicId: string;

  @ApiProperty({ description: 'S3 multipart `UploadId`.' })
  uploadId: string;

  @ApiProperty({
    description: 'Size of every part except the last one, in bytes.',
    example: 67108864,
  })
  partSize: number;

  @ApiProperty({ example: 160 })
  partCount: number;

  @ApiProperty({
    type: [PartUrlDto],
    description: 'First batch of part URLs (at most 100, ascending).',
  })
  parts: PartUrlDto[];

  @ApiProperty({
    format: 'date-time',
    description: 'Expiry of the part URLs in this response.',
  })
  expiresAt: string;
}

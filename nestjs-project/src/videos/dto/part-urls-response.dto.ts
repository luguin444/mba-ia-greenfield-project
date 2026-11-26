import { ApiProperty } from '@nestjs/swagger';
import { PartUrlDto } from './part-url.dto';
import { UploadedPartDto } from './uploaded-part.dto';

export class PartUrlsResponseDto {
  @ApiProperty({ format: 'uuid' })
  videoId: string;

  @ApiProperty({ description: 'S3 multipart `UploadId`.' })
  uploadId: string;

  @ApiProperty({ example: 67108864 })
  partSize: number;

  @ApiProperty({ example: 160 })
  partCount: number;

  @ApiProperty({
    type: [UploadedPartDto],
    description: 'Every part already stored, ascending.',
  })
  uploadedParts: UploadedPartDto[];

  @ApiProperty({
    type: [PartUrlDto],
    description:
      'Newly signed part URLs. Empty when nothing is missing and no `partNumbers` were given.',
  })
  parts: PartUrlDto[];

  @ApiProperty({
    format: 'date-time',
    description: 'Expiry of the part URLs in this response.',
  })
  expiresAt: string;
}

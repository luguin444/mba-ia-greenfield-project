import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1, minimum: 1 })
  partNumber: number;

  @ApiProperty({ description: 'Stored part size in bytes.', example: 5242880 })
  size: number;

  @ApiProperty({ example: '"5d41402abc4b2a76b9719d911017c592"' })
  etag: string;
}

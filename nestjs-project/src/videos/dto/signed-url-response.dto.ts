import { ApiProperty } from '@nestjs/swagger';

export class SignedUrlResponseDto {
  @ApiProperty({
    description:
      'Presigned GET straight to storage. Supports HTTP Range (206), so a `<video>` can stream it.',
    example:
      'http://minio.localhost:9000/videos/0b6f…/source?X-Amz-Expires=14400&X-Amz-Signature=…',
  })
  url: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Expiry of `url`. Ask for a new one after it.',
  })
  expiresAt: string;
}

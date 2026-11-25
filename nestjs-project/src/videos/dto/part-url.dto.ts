import { ApiProperty } from '@nestjs/swagger';

export class PartUrlDto {
  @ApiProperty({ example: 1, minimum: 1 })
  partNumber: number;

  @ApiProperty({
    description: 'Presigned `UploadPart` URL. PUT the part bytes to it.',
    example:
      'http://minio.localhost:9000/videos/0b6f…/source?partNumber=1&uploadId=…&X-Amz-Signature=…',
  })
  url: string;
}

import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT ?? '',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? '',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY ?? '',
  secretKey: process.env.S3_SECRET_KEY ?? '',
  videosBucket: process.env.S3_VIDEOS_BUCKET ?? 'videos',
  thumbnailsBucket: process.env.S3_THUMBNAILS_BUCKET ?? 'thumbnails',
}));

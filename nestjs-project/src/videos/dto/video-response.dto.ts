import { ApiProperty } from '@nestjs/swagger';
import {
  VideoFailureReason,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', minLength: 11, maxLength: 11 })
  publicId: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoProcessingStatus })
  processingStatus: VideoProcessingStatus;

  @ApiProperty({ enum: VideoPublicationStatus })
  publicationStatus: VideoPublicationStatus;

  @ApiProperty({ enum: VideoFailureReason, nullable: true, type: String })
  failureReason: VideoFailureReason | null;

  @ApiProperty({ example: 'aula.mp4' })
  fileName: string;

  @ApiProperty({ example: 'video/mp4' })
  mimeType: string;

  @ApiProperty({ example: 10737418240 })
  sizeBytes: number;

  @ApiProperty({ type: Number, nullable: true, example: 12.5 })
  durationSeconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  videoCodec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audioCodec: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  formatName: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Public, unsigned URL of the thumbnail',
  })
  thumbnailUrl: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  processedAt: string | null;
}

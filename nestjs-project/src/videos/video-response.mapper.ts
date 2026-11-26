import type { VideoResponseDto } from './dto/video-response.dto';
import type { Video } from './entities/video.entity';

/** Entity (snake_case, `Date`) → wire shape (camelCase, ISO-8601 strings). */
export function toVideoResponse(
  video: Video,
  thumbnailUrl: string | null,
): VideoResponseDto {
  return {
    id: video.id,
    publicId: video.public_id,
    title: video.title,
    processingStatus: video.processing_status,
    publicationStatus: video.publication_status,
    failureReason: video.failure_reason,
    fileName: video.original_filename,
    mimeType: video.mime_type,
    sizeBytes: video.size_bytes,
    durationSeconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    videoCodec: video.video_codec,
    audioCodec: video.audio_codec,
    formatName: video.format_name,
    thumbnailUrl,
    createdAt: video.created_at.toISOString(),
    updatedAt: video.updated_at.toISOString(),
    processedAt: video.processed_at ? video.processed_at.toISOString() : null,
  };
}

import {
  Video,
  VideoFailureReason,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './entities/video.entity';
import { toVideoResponse } from './video-response.mapper';

function buildVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: '7d4f3a52-1f3e-4b7e-9a0e-2a3a4b5c6d7e',
    public_id: 'aZ09-_aZ09-',
    title: 'aula',
    channel_id: 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f',
    processing_status: VideoProcessingStatus.UPLOADING,
    publication_status: VideoPublicationStatus.DRAFT,
    failure_reason: null,
    original_filename: 'aula.mp4',
    mime_type: 'video/mp4',
    size_bytes: 10737418240,
    upload_id: 'upload-1',
    upload_part_size_bytes: 67108864,
    source_key: '7d4f3a52-1f3e-4b7e-9a0e-2a3a4b5c6d7e/source',
    thumbnail_key: null,
    duration_seconds: null,
    width: null,
    height: null,
    video_codec: null,
    audio_codec: null,
    format_name: null,
    processed_at: null,
    created_at: new Date('2026-11-25T10:00:00.000Z'),
    updated_at: new Date('2026-11-25T10:05:00.000Z'),
    ...overrides,
  });
}

describe('toVideoResponse', () => {
  it('should map an uploading video to the camelCase wire shape with null metadata', () => {
    const video = buildVideo();

    const response = toVideoResponse(video, null);

    expect(response).toEqual({
      id: video.id,
      publicId: 'aZ09-_aZ09-',
      title: 'aula',
      processingStatus: 'uploading',
      publicationStatus: 'draft',
      failureReason: null,
      fileName: 'aula.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10737418240,
      durationSeconds: null,
      width: null,
      height: null,
      videoCodec: null,
      audioCodec: null,
      formatName: null,
      thumbnailUrl: null,
      createdAt: '2026-11-25T10:00:00.000Z',
      updatedAt: '2026-11-25T10:05:00.000Z',
      processedAt: null,
    });
  });

  it('should never expose storage internals or the owning channel', () => {
    const response = toVideoResponse(buildVideo(), null);

    expect(response).not.toHaveProperty('upload_id');
    expect(response).not.toHaveProperty('uploadId');
    expect(response).not.toHaveProperty('sourceKey');
    expect(response).not.toHaveProperty('channelId');
  });

  it('should pass the thumbnail URL through and format processedAt for a ready video', () => {
    const thumbnailUrl =
      'http://minio.localhost:9000/thumbnails/7d4f3a52/default.jpg';
    const video = buildVideo({
      processing_status: VideoProcessingStatus.READY,
      thumbnail_key: '7d4f3a52/default.jpg',
      duration_seconds: 12.5,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      processed_at: new Date('2026-11-25T10:06:00.000Z'),
    });

    const response = toVideoResponse(video, thumbnailUrl);

    expect(response).toMatchObject({
      processingStatus: 'ready',
      thumbnailUrl,
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      processedAt: '2026-11-25T10:06:00.000Z',
    });
  });

  it('should expose the failure reason of a failed video', () => {
    const response = toVideoResponse(
      buildVideo({
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: VideoFailureReason.UPLOAD_ABORTED,
      }),
      null,
    );

    expect(response.processingStatus).toBe('failed');
    expect(response.failureReason).toBe('UPLOAD_ABORTED');
  });
});

import { randomUUID } from 'crypto';
import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import type { InitiateUploadResponseDto } from '../src/videos/dto/initiate-upload-response.dto';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import {
  closeVideosE2eApp,
  createVideosE2eApp,
  expiredAccessToken,
  initiateUpload,
  registerConfirmAndLogin,
  type TestUser,
  type VideosE2eContext,
} from './support/videos-e2e';

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const THUMBNAILS_BUCKET = 'thumbnails-test';
// Smallest JPEG framing (SOI + EOI); the storage only cares about the bytes.
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('videos-detail', () => {
  let ctx: VideosE2eContext;
  let owner: TestUser;
  let other: TestUser;
  let initiated: InitiateUploadResponseDto;

  beforeAll(async () => {
    ctx = await createVideosE2eApp();
  });

  afterAll(async () => {
    await closeVideosE2eApp(ctx);
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    ctx.throttlerStorage.storage.clear();
    owner = await registerConfirmAndLogin(ctx.app, 'owner@example.com');
    other = await registerConfirmAndLogin(ctx.app, 'other@example.com');
    initiated = await initiateUpload(ctx.app, owner.accessToken, {
      fileName: 'clip.mp4',
      sizeBytes: 1048576,
      mimeType: 'video/mp4',
    });
  });

  function getVideo(videoId: string, token: string | null) {
    const req = request(ctx.app.getHttpServer()).get(`/videos/${videoId}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  // 1. Detalhe do vídeo para o dono

  it('dono-recebe-video-no-status-atual-com-metadados-nulos', async () => {
    const res = await getVideo(initiated.videoId, owner.accessToken).expect(
      200,
    );

    const body = res.body as VideoResponseDto;
    expect(body).toMatchObject({
      id: initiated.videoId,
      processingStatus: 'uploading',
      publicationStatus: 'draft',
      failureReason: null,
      title: 'clip',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1048576,
      durationSeconds: null,
      width: null,
      height: null,
      videoCodec: null,
      audioCodec: null,
      formatName: null,
      thumbnailUrl: null,
      processedAt: null,
    });
    expect(body.publicId).toHaveLength(11);
    expect(body.createdAt).toMatch(ISO_8601);
    expect(body.updatedAt).toMatch(ISO_8601);
    for (const internal of [
      'uploadId',
      'upload_id',
      'sourceKey',
      'source_key',
      'channelId',
      'channel_id',
    ]) {
      expect(body).not.toHaveProperty(internal);
    }
  });

  it('thumbnail-preenchida-vira-url-publica-sem-assinatura', async () => {
    const storage = ctx.app.get(StorageService);
    const thumbnailKey = `${initiated.videoId}/default.jpg`;
    await storage.putObject(
      THUMBNAILS_BUCKET,
      thumbnailKey,
      TINY_JPEG,
      'image/jpeg',
    );
    try {
      await ctx.dataSource.getRepository(Video).update(
        { id: initiated.videoId },
        {
          processing_status: VideoProcessingStatus.READY,
          upload_id: null,
          thumbnail_key: thumbnailKey,
          duration_seconds: 12.5,
          width: 1280,
          height: 720,
          video_codec: 'h264',
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          processed_at: new Date(),
        },
      );

      const res = await getVideo(initiated.videoId, owner.accessToken).expect(
        200,
      );

      const body = res.body as VideoResponseDto;
      expect(body).toMatchObject({
        processingStatus: 'ready',
        durationSeconds: 12.5,
        width: 1280,
        height: 720,
        videoCodec: 'h264',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      });
      expect(body.processedAt).toMatch(ISO_8601);
      expect(body.thumbnailUrl).toBe(
        `http://minio.localhost:9000/${THUMBNAILS_BUCKET}/${thumbnailKey}`,
      );
      expect(body.thumbnailUrl).not.toContain('X-Amz-');

      const thumbnail = await fetch(body.thumbnailUrl as string);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    } finally {
      await storage.deleteObject(THUMBNAILS_BUCKET, thumbnailKey);
    }
  });

  // 2. Autorização e validação (hide, don't forbid)

  it('nao-dono-e-id-inexistente-recebem-404-identico', async () => {
    const nonOwner = await getVideo(
      initiated.videoId,
      other.accessToken,
    ).expect(404);
    expect(nonOwner.body).toEqual({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
      message: 'Video not found',
    });

    const missing = await getVideo(randomUUID(), owner.accessToken).expect(404);
    expect(missing.body).toEqual(nonOwner.body);
  });

  it('sem-token-ou-token-expirado-retorna-401', async () => {
    await getVideo(initiated.videoId, null).expect(401);
    await getVideo(
      initiated.videoId,
      expiredAccessToken(ctx.app, owner),
    ).expect(401);
  });

  it('id-que-nao-e-uuid-retorna-400', async () => {
    const res = await getVideo('not-a-uuid', owner.accessToken).expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
  });
});

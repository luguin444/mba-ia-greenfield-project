import { randomUUID } from 'crypto';
import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { cleanAllTables } from '../src/test/create-test-data-source';
import type { InitiateUploadResponseDto } from '../src/videos/dto/initiate-upload-response.dto';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import {
  closeVideosE2eApp,
  createVideosE2eApp,
  expiredAccessToken,
  initiateUpload,
  putPart,
  registerConfirmAndLogin,
  type TestUser,
  type VideosE2eContext,
} from './support/videos-e2e';

const MIB = 1024 * 1024;
const UPLOAD_BODY = {
  fileName: 'clip.mp4',
  sizeBytes: 10485760,
  mimeType: 'video/mp4',
};
const INVALID_VIDEO_STATE = {
  statusCode: 409,
  error: 'INVALID_VIDEO_STATE',
  message: 'Operation not allowed in the current video state',
};

describe('videos-upload-abort', () => {
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
    initiated = await initiateUpload(ctx.app, owner.accessToken, UPLOAD_BODY);
  });

  function deleteUpload(videoId: string, token: string | null) {
    const req = request(ctx.app.getHttpServer()).delete(
      `/videos/${videoId}/upload`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  function readRow(videoId: string): Promise<Video> {
    return ctx.dataSource.getRepository(Video).findOneByOrFail({ id: videoId });
  }

  // 1. Abortar upload em andamento

  it('dono-aborta-e-recebe-204', async () => {
    const res = await deleteUpload(initiated.videoId, owner.accessToken).expect(
      204,
    );
    expect(res.text).toBe('');

    const row = await readRow(initiated.videoId);
    expect(row.processing_status).toBe('failed');
    expect(row.failure_reason).toBe('UPLOAD_ABORTED');
    expect(row.upload_id).toBeNull();

    const put = await putPart(initiated.parts[0].url, 5 * MIB);
    expect(put.status).toBe(404);
    expect(await put.text()).toContain('NoSuchUpload');
  });

  it('abort-libera-slot-do-teto-de-uploads-ativos', async () => {
    for (let i = 1; i < 5; i++) {
      await initiateUpload(ctx.app, owner.accessToken, UPLOAD_BODY);
    }
    const blocked = await request(ctx.app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(UPLOAD_BODY)
      .expect(409);
    expect((blocked.body as ApiErrorEnvelope).error).toBe(
      'ACTIVE_UPLOAD_LIMIT_REACHED',
    );

    await deleteUpload(initiated.videoId, owner.accessToken).expect(204);

    await request(ctx.app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(UPLOAD_BODY)
      .expect(201);
  });

  // 2. Estado inválido

  it('repetir-delete-ou-video-fora-de-uploading-retorna-409', async () => {
    await deleteUpload(initiated.videoId, owner.accessToken).expect(204);

    const repeated = await deleteUpload(
      initiated.videoId,
      owner.accessToken,
    ).expect(409);
    expect(repeated.body).toEqual(INVALID_VIDEO_STATE);

    const processing = await initiateUpload(
      ctx.app,
      owner.accessToken,
      UPLOAD_BODY,
    );
    await ctx.dataSource
      .getRepository(Video)
      .update(
        { id: processing.videoId },
        { processing_status: VideoProcessingStatus.PROCESSING },
      );
    const notUploading = await deleteUpload(
      processing.videoId,
      owner.accessToken,
    ).expect(409);
    expect(notUploading.body).toEqual(INVALID_VIDEO_STATE);
    expect((await readRow(processing.videoId)).processing_status).toBe(
      'processing',
    );
  });

  // 3. Autorização e validação (hide, don't forbid)

  it('nao-dono-e-id-inexistente-recebem-404-identico', async () => {
    const nonOwner = await deleteUpload(
      initiated.videoId,
      other.accessToken,
    ).expect(404);
    expect(nonOwner.body).toEqual({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
      message: 'Video not found',
    });

    const missing = await deleteUpload(randomUUID(), owner.accessToken).expect(
      404,
    );
    expect(missing.body).toEqual(nonOwner.body);

    const row = await readRow(initiated.videoId);
    expect(row.processing_status).toBe('uploading');
    expect(row.upload_id).toBe(initiated.uploadId);
  });

  it('sem-token-401-e-id-invalido-400', async () => {
    await deleteUpload(initiated.videoId, null).expect(401);
    await deleteUpload(
      initiated.videoId,
      expiredAccessToken(ctx.app, owner),
    ).expect(401);
    const badId = await deleteUpload('not-a-uuid', owner.accessToken).expect(
      400,
    );
    expect((badId.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');

    expect((await readRow(initiated.videoId)).processing_status).toBe(
      'uploading',
    );
  });
});

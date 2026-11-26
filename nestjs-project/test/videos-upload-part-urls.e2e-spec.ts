import { randomUUID } from 'crypto';
import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { cleanAllTables } from '../src/test/create-test-data-source';
import type { InitiateUploadResponseDto } from '../src/videos/dto/initiate-upload-response.dto';
import type { PartUrlsResponseDto } from '../src/videos/dto/part-urls-response.dto';
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
const VIDEO_NOT_FOUND = {
  statusCode: 404,
  error: 'VIDEO_NOT_FOUND',
  message: 'Video not found',
};

describe('videos-upload-part-urls', () => {
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
      sizeBytes: 10485760,
      mimeType: 'video/mp4',
    });
    const put = await putPart(initiated.parts[0].url, 5 * MIB);
    expect(put.status).toBe(200);
  });

  function postPartUrls(
    videoId: string,
    token: string | null,
    body?: Record<string, unknown>,
  ) {
    const req = request(ctx.app.getHttpServer()).post(
      `/videos/${videoId}/upload/part-urls`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  }

  async function readUpdatedAt(): Promise<Date> {
    const row = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: initiated.videoId });
    return row.updated_at;
  }

  // 1. Retomar upload e assinar partes

  it('retomada-sem-body-assina-as-faltantes-e-avanca-updated-at', async () => {
    const updatedAtBefore = await readUpdatedAt();

    const res = await postPartUrls(initiated.videoId, owner.accessToken).expect(
      200,
    );

    const body = res.body as PartUrlsResponseDto;
    expect(body.videoId).toBe(initiated.videoId);
    expect(body.uploadId).toBe(initiated.uploadId);
    expect(body.partSize).toBe(5242880);
    expect(body.partCount).toBe(2);
    expect(body.uploadedParts).toEqual([
      { partNumber: 1, size: 5242880, etag: expect.any(String) as unknown },
    ]);
    expect(body.uploadedParts[0].etag.length).toBeGreaterThan(0);
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0].partNumber).toBe(2);
    expect(new URL(body.parts[0].url).host).toBe('minio.localhost:9000');
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);

    const updatedAtAfter = await readUpdatedAt();
    expect(updatedAtAfter.getTime()).toBeGreaterThan(updatedAtBefore.getTime());
  });

  it('partnumbers-explicitos-reassinam-parte-ja-enviada', async () => {
    const res = await postPartUrls(initiated.videoId, owner.accessToken, {
      partNumbers: [1],
    }).expect(200);

    const body = res.body as PartUrlsResponseDto;
    expect(body.parts.map((part) => part.partNumber)).toEqual([1]);
    expect(body.uploadedParts.map((part) => part.partNumber)).toEqual([1]);

    const rePut = await putPart(body.parts[0].url, 5 * MIB);
    expect(rePut.status).toBe(200);
    expect(rePut.headers.get('etag')).toBeTruthy();
  });

  // 2. Erros de entrada e de estado

  it('part-number-maior-que-part-count-retorna-400', async () => {
    const res = await postPartUrls(initiated.videoId, owner.accessToken, {
      partNumbers: [3],
    }).expect(400);

    expect(res.body).toEqual({
      statusCode: 400,
      error: 'INVALID_PART_NUMBER',
      message: 'Part number out of range',
    });
  });

  it('id-ou-body-invalido-retorna-400-validation-error', async () => {
    const badId = await postPartUrls('not-a-uuid', owner.accessToken).expect(
      400,
    );
    expect((badId.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');

    const invalidBodies: Record<string, unknown>[] = [
      { partNumbers: [] },
      { partNumbers: [1, 1] },
      { partNumbers: [0] },
      { foo: 1 },
    ];
    for (const body of invalidBodies) {
      const res = await postPartUrls(
        initiated.videoId,
        owner.accessToken,
        body,
      ).expect(400);
      expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
    }
  });

  it('video-fora-de-uploading-retorna-409', async () => {
    await ctx.dataSource.getRepository(Video).update(
      { id: initiated.videoId },
      {
        processing_status: VideoProcessingStatus.PROCESSING,
        upload_id: null,
      },
    );

    const res = await postPartUrls(initiated.videoId, owner.accessToken).expect(
      409,
    );

    expect(res.body).toEqual({
      statusCode: 409,
      error: 'INVALID_VIDEO_STATE',
      message: 'Operation not allowed in the current video state',
    });
  });

  // 3. Autorização (hide, don't forbid)

  it('nao-dono-e-id-inexistente-recebem-404-identico', async () => {
    const updatedAtBefore = await readUpdatedAt();

    const nonOwner = await postPartUrls(
      initiated.videoId,
      other.accessToken,
    ).expect(404);
    expect(nonOwner.body).toEqual(VIDEO_NOT_FOUND);

    const missing = await postPartUrls(randomUUID(), owner.accessToken).expect(
      404,
    );
    expect(missing.body).toEqual(nonOwner.body);

    expect(await readUpdatedAt()).toEqual(updatedAtBefore);
  });

  it('sem-token-ou-token-expirado-retorna-401', async () => {
    await postPartUrls(initiated.videoId, null).expect(401);
    await postPartUrls(
      initiated.videoId,
      expiredAccessToken(ctx.app, owner),
    ).expect(401);
  });
});

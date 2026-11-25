import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import type { InitiateUploadResponseDto } from '../src/videos/dto/initiate-upload-response.dto';
import type { PartUrlsResponseDto } from '../src/videos/dto/part-urls-response.dto';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import { Video } from '../src/videos/entities/video.entity';
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
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VIDEO_NOT_FOUND = {
  statusCode: 404,
  error: 'VIDEO_NOT_FOUND',
  message: 'Video not found',
};

describe('videos-upload-complete', () => {
  let ctx: VideosE2eContext;
  let queue: Queue;
  let owner: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    ctx = await createVideosE2eApp();
    queue = ctx.moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await closeVideosE2eApp(ctx);
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    ctx.throttlerStorage.storage.clear();
    owner = await registerConfirmAndLogin(ctx.app, 'owner@example.com');
    other = await registerConfirmAndLogin(ctx.app, 'other@example.com');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function postComplete(videoId: string, token: string | null) {
    const req = request(ctx.app.getHttpServer()).post(
      `/videos/${videoId}/upload/complete`,
    );
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  function readRow(videoId: string): Promise<Video> {
    return ctx.dataSource.getRepository(Video).findOneByOrFail({ id: videoId });
  }

  /** 2 parts of 5 MiB, both PUT (part 2 first) straight to storage. */
  async function uploadTwoFullParts(): Promise<InitiateUploadResponseDto> {
    const initiated = await initiateUpload(ctx.app, owner.accessToken, {
      fileName: 'clip.mp4',
      sizeBytes: 10485760,
      mimeType: 'video/mp4',
    });
    expect((await putPart(initiated.parts[1].url, 5 * MIB)).status).toBe(200);
    expect((await putPart(initiated.parts[0].url, 5 * MIB)).status).toBe(200);
    return initiated;
  }

  async function uploadSinglePart(): Promise<InitiateUploadResponseDto> {
    const initiated = await initiateUpload(ctx.app, owner.accessToken, {
      fileName: 'clip.mp4',
      sizeBytes: 1048576,
      mimeType: 'video/mp4',
    });
    expect((await putPart(initiated.parts[0].url, MIB)).status).toBe(200);
    return initiated;
  }

  // 1. Completar upload e enfileirar processamento

  it('todas-as-partes-enviadas-retorna-202-e-enfileira-job', async () => {
    const initiated = await uploadTwoFullParts();

    const res = await postComplete(initiated.videoId, owner.accessToken).expect(
      202,
    );

    const body = res.body as VideoResponseDto;
    expect(body).toMatchObject({
      id: initiated.videoId,
      processingStatus: 'processing',
      publicationStatus: 'draft',
      failureReason: null,
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10485760,
      durationSeconds: null,
      width: null,
      height: null,
      videoCodec: null,
      audioCodec: null,
      formatName: null,
      thumbnailUrl: null,
      processedAt: null,
    });
    expect(body.createdAt).toMatch(ISO_8601);
    expect(body.updatedAt).toMatch(ISO_8601);

    const row = await readRow(initiated.videoId);
    expect(row.processing_status).toBe('processing');
    expect(row.upload_id).toBeNull();

    const job = await queue.getJob(initiated.videoId);
    expect(job?.name).toBe('process-video');
    expect(job?.data).toEqual({ videoId: initiated.videoId });
  });

  it('segundo-complete-retorna-409-invalid-video-state', async () => {
    const initiated = await uploadTwoFullParts();
    await postComplete(initiated.videoId, owner.accessToken).expect(202);

    const res = await postComplete(initiated.videoId, owner.accessToken).expect(
      409,
    );

    expect(res.body).toEqual({
      statusCode: 409,
      error: 'INVALID_VIDEO_STATE',
      message: 'Operation not allowed in the current video state',
    });
    expect((await readRow(initiated.videoId)).processing_status).toBe(
      'processing',
    );
  });

  it('falha-no-enqueue-ainda-retorna-202-e-loga-erro', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const addSpy = jest.spyOn(queue, 'add');

    // Redis refusing connections: `add` rejects.
    addSpy.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const refused = await uploadSinglePart();
    const refusedRes = await postComplete(
      refused.videoId,
      owner.accessToken,
    ).expect(202);
    expect((refusedRes.body as VideoResponseDto).processingStatus).toBe(
      'processing',
    );
    const refusedRow = await readRow(refused.videoId);
    expect(refusedRow.processing_status).toBe('processing');
    expect(refusedRow.upload_id).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(refused.videoId),
      expect.any(String),
    );

    // Redis not answering: the real `add` would stay pending forever.
    addSpy.mockImplementationOnce(() => new Promise(() => undefined));
    const hanging = await uploadSinglePart();
    const startedAt = Date.now();
    const hangingRes = await postComplete(
      hanging.videoId,
      owner.accessToken,
    ).expect(202);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect((hangingRes.body as VideoResponseDto).processingStatus).toBe(
      'processing',
    );
    const hangingRow = await readRow(hanging.videoId);
    expect(hangingRow.processing_status).toBe('processing');
    expect(hangingRow.upload_id).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(hanging.videoId),
      expect.any(String),
    );
  }, 20000);

  // 2. Upload incompleto ou com tamanho divergente

  it('partes-faltando-retorna-409-upload-incomplete-e-segue-retomavel', async () => {
    const initiated = await initiateUpload(ctx.app, owner.accessToken, {
      fileName: 'clip.mp4',
      sizeBytes: 10485760,
      mimeType: 'video/mp4',
    });
    expect((await putPart(initiated.parts[0].url, 5 * MIB)).status).toBe(200);

    const res = await postComplete(initiated.videoId, owner.accessToken).expect(
      409,
    );
    expect(res.body).toMatchObject({
      error: 'UPLOAD_INCOMPLETE',
      message: 'Upload is missing parts: 2',
    });

    const row = await readRow(initiated.videoId);
    expect(row.processing_status).toBe('uploading');
    expect(row.upload_id).toBe(initiated.uploadId);

    const resume = await request(ctx.app.getHttpServer())
      .post(`/videos/${initiated.videoId}/upload/part-urls`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(
      (resume.body as PartUrlsResponseDto).parts.map((p) => p.partNumber),
    ).toEqual([2]);
  });

  it('soma-das-partes-divergente-retorna-422', async () => {
    const initiated = await initiateUpload(ctx.app, owner.accessToken, {
      fileName: 'clip.mp4',
      sizeBytes: 2048,
      mimeType: 'video/mp4',
    });
    expect((await putPart(initiated.parts[0].url, 1024)).status).toBe(200);

    const res = await postComplete(initiated.videoId, owner.accessToken).expect(
      422,
    );
    expect(res.body).toEqual({
      statusCode: 422,
      error: 'UPLOAD_SIZE_MISMATCH',
      message: 'Uploaded size does not match the declared size',
    });

    const row = await readRow(initiated.videoId);
    expect(row.processing_status).toBe('uploading');
    expect(row.failure_reason).toBeNull();
    expect(row.upload_id).toBe(initiated.uploadId);
    await expect(queue.getJob(initiated.videoId)).resolves.toBeUndefined();
  });

  // 3. Autorização e validação (hide, don't forbid)

  it('nao-dono-e-id-inexistente-recebem-404-identico', async () => {
    const initiated = await uploadTwoFullParts();

    const nonOwner = await postComplete(
      initiated.videoId,
      other.accessToken,
    ).expect(404);
    expect(nonOwner.body).toEqual(VIDEO_NOT_FOUND);

    const missing = await postComplete(randomUUID(), owner.accessToken).expect(
      404,
    );
    expect(missing.body).toEqual(nonOwner.body);

    expect((await readRow(initiated.videoId)).processing_status).toBe(
      'uploading',
    );
    await expect(queue.getJob(initiated.videoId)).resolves.toBeUndefined();
  });

  it('sem-token-401-e-id-invalido-400', async () => {
    const initiated = await uploadTwoFullParts();

    await postComplete(initiated.videoId, null).expect(401);
    await postComplete(
      initiated.videoId,
      expiredAccessToken(ctx.app, owner),
    ).expect(401);
    const badId = await postComplete('not-a-uuid', owner.accessToken).expect(
      400,
    );
    expect((badId.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
  });
});

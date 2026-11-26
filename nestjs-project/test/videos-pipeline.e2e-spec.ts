import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import request from 'supertest';
import queueConfig from '../src/config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import type { PartUrlsResponseDto } from '../src/videos/dto/part-urls-response.dto';
import type { SignedUrlResponseDto } from '../src/videos/dto/signed-url-response.dto';
import type { VideoResponseDto } from '../src/videos/dto/video-response.dto';
import {
  VideoFailureReason,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import { PUBLIC_ID_PATTERN } from '../src/videos/public-id.util';
import {
  fileSize,
  generatePipelineVideo,
  putFileParts,
  startVideoPipeline,
  stopVideoPipeline,
  uploadViaPresignedParts,
  waitForStatus,
  type VideoPipelineContext,
} from './helpers/video-pipeline';
import { registerConfirmAndLogin, type TestUser } from './support/videos-e2e';

const NOT_A_VIDEO_PATH = join(__dirname, 'fixtures', 'not-a-video.mp4');
/** Prefix of the `video-worker` dev container, which must never see a test job. */
const CONTAINER_QUEUE_PREFIX = 'bull';
const PROCESSING_TIMEOUT_MS = 60000;
const TEST_TIMEOUT_MS = 90000;
const RANGE_BYTES = 1024;

describe('videos-pipeline', () => {
  let ctx: VideoPipelineContext;
  let owner: TestUser;
  let videoPath: string;

  beforeAll(async () => {
    videoPath = await generatePipelineVideo();
    ctx = await startVideoPipeline();
    await cleanAllTables(ctx.dataSource);
    ctx.throttlerStorage.storage.clear();
    owner = await registerConfirmAndLogin(ctx.app, 'pipeline@example.com');
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      if (ctx) await stopVideoPipeline(ctx);
    } finally {
      if (videoPath) await rm(videoPath, { force: true });
    }
  });

  function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${owner.accessToken}`);
  }

  async function complete(videoId: string): Promise<void> {
    await authed(
      request(ctx.app.getHttpServer()).post(
        `/videos/${videoId}/upload/complete`,
      ),
    ).expect(202);
  }

  /** Uploads a file in one go (all parts of the first batch), completes it and waits for `status`. */
  async function uploadAndProcess(
    filePath: string,
    fileName: string,
    status: VideoProcessingStatus,
  ): Promise<VideoResponseDto> {
    const initiated = await uploadViaPresignedParts(
      ctx.app,
      owner.accessToken,
      { fileName, sizeBytes: await fileSize(filePath), mimeType: 'video/mp4' },
      filePath,
    );
    await complete(initiated.videoId);
    return waitForStatus(
      ctx.app,
      owner.accessToken,
      initiated.videoId,
      status,
      PROCESSING_TIMEOUT_MS,
    );
  }

  // (a) Upload multipart retomável → processamento → ready

  it(
    'upload-de-3-partes-com-pausa-e-retomada-chega-a-ready-com-metadados-e-thumbnail',
    async () => {
      const sizeBytes = await fileSize(videoPath);
      const initiated = await uploadViaPresignedParts(
        ctx.app,
        owner.accessToken,
        { fileName: 'pipeline.mp4', sizeBytes, mimeType: 'video/mp4' },
        videoPath,
        { stopAfterPart: 1 },
      );
      expect(initiated.partCount).toBe(3);

      const resumed = await authed(
        request(ctx.app.getHttpServer()).post(
          `/videos/${initiated.videoId}/upload/part-urls`,
        ),
      )
        .send({})
        .expect(200);
      const resume = resumed.body as PartUrlsResponseDto;
      expect(resume.uploadedParts.map((part) => part.partNumber)).toEqual([1]);
      expect(resume.parts.map((part) => part.partNumber)).toEqual([2, 3]);
      await putFileParts(videoPath, resume.partSize, resume.parts);
      await complete(initiated.videoId);

      const video = await waitForStatus(
        ctx.app,
        owner.accessToken,
        initiated.videoId,
        VideoProcessingStatus.READY,
        PROCESSING_TIMEOUT_MS,
      );

      expect(video).toMatchObject({
        sizeBytes,
        failureReason: null,
        width: 640,
        height: 360,
        videoCodec: 'h264',
      });
      expect(video.durationSeconds).toBeGreaterThan(0);
      expect(video.processedAt).not.toBeNull();
      expect(video.thumbnailUrl).toEqual(expect.any(String));
      const thumbnail = await fetch(video.thumbnailUrl as string);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    },
    TEST_TIMEOUT_MS,
  );

  // (b) Streaming com Range e download como anexo

  describe('video pronto', () => {
    let ready: VideoResponseDto;

    beforeAll(async () => {
      ready = await uploadAndProcess(
        videoPath,
        'pipeline-stream.mp4',
        VideoProcessingStatus.READY,
      );
    }, TEST_TIMEOUT_MS);

    it('playback-responde-206-a-um-range-sem-baixar-o-arquivo-inteiro', async () => {
      const res = await authed(
        request(ctx.app.getHttpServer()).get(
          `/videos/${ready.publicId}/playback`,
        ),
      ).expect(200);

      const file = await fetch((res.body as SignedUrlResponseDto).url, {
        headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
      });

      expect(file.status).toBe(206);
      expect(file.headers.get('content-range')).toBe(
        `bytes 0-${RANGE_BYTES - 1}/${ready.sizeBytes}`,
      );
      expect((await file.arrayBuffer()).byteLength).toBe(RANGE_BYTES);
    });

    it('download-responde-como-anexo-com-o-tamanho-declarado', async () => {
      const res = await authed(
        request(ctx.app.getHttpServer()).get(
          `/videos/${ready.publicId}/download`,
        ),
      ).expect(200);

      const file = await fetch((res.body as SignedUrlResponseDto).url);

      expect(file.status).toBe(200);
      expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect((await file.arrayBuffer()).byteLength).toBe(ready.sizeBytes);
    });
  });

  // (c) Mídia inválida

  it(
    'arquivo-que-nao-e-video-termina-failed-com-invalid-media',
    async () => {
      const video = await uploadAndProcess(
        NOT_A_VIDEO_PATH,
        'not-a-video.mp4',
        VideoProcessingStatus.FAILED,
      );

      expect(video.failureReason).toBe(VideoFailureReason.INVALID_MEDIA);
      expect(video.thumbnailUrl).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  // (d) URLs únicas

  it('dois-uploads-seguidos-geram-public-ids-distintos-de-11-caracteres', async () => {
    const body = {
      fileName: 'unico.mp4',
      sizeBytes: 1048576,
      mimeType: 'video/mp4',
    };
    const initiate = async (): Promise<string> => {
      const res = await authed(
        request(ctx.app.getHttpServer()).post('/videos/uploads'),
      )
        .send(body)
        .expect(201);
      return (res.body as { publicId: string }).publicId;
    };

    const first = await initiate();
    const second = await initiate();

    expect(first).toMatch(PUBLIC_ID_PATTERN);
    expect(second).toMatch(PUBLIC_ID_PATTERN);
    expect(first).not.toBe(second);
  });

  // Isolamento: fila de prefixo "test" e buckets "-test"

  it(
    'o-ciclo-usa-so-a-fila-test-e-os-buckets-test-e-nenhum-job-do-video-aparece-sob-bull',
    async () => {
      const initiated = await uploadViaPresignedParts(
        ctx.app,
        owner.accessToken,
        {
          fileName: 'isolado.mp4',
          sizeBytes: await fileSize(NOT_A_VIDEO_PATH),
          mimeType: 'video/mp4',
        },
        NOT_A_VIDEO_PATH,
      );
      expect(new URL(initiated.parts[0].url).pathname).toBe(
        `/videos-test/${initiated.videoId}/source`,
      );
      await complete(initiated.videoId);
      await waitForStatus(
        ctx.app,
        owner.accessToken,
        initiated.videoId,
        VideoProcessingStatus.FAILED,
        PROCESSING_TIMEOUT_MS,
      );

      // `INVALID_MEDIA` jobs stay in the failed set, so the job is observable.
      const testQueue = ctx.app.get<Queue>(
        getQueueToken(VIDEO_PROCESSING_QUEUE),
        { strict: false },
      );
      expect(testQueue.opts.prefix).toBe('test');
      const testJob = await testQueue.getJob(initiated.videoId);
      expect(testJob?.data).toEqual({ videoId: initiated.videoId });
      expect(await testJob?.getState()).toBe('failed');

      // The dev container legitimately owns `bull:video-maintenance:*` keys, so
      // the check is on this video's job id in `video-processing`, not on `bull:*`.
      const { host, port } = ctx.app.get<ConfigType<typeof queueConfig>>(
        queueConfig.KEY,
      );
      const containerQueue = new Queue(VIDEO_PROCESSING_QUEUE, {
        connection: { host, port },
        prefix: CONTAINER_QUEUE_PREFIX,
      });
      try {
        await expect(
          containerQueue.getJob(initiated.videoId),
        ).resolves.toBeUndefined();
      } finally {
        await containerQueue.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

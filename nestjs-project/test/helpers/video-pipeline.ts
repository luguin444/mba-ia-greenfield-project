import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { cleanAllTables } from '../../src/test/create-test-data-source';
import { obliterateTestQueues } from '../../src/test/queues';
import type { InitiateUploadResponseDto } from '../../src/videos/dto/initiate-upload-response.dto';
import type { PartUrlDto } from '../../src/videos/dto/part-url.dto';
import type { VideoResponseDto } from '../../src/videos/dto/video-response.dto';
import { VideoProcessingStatus } from '../../src/videos/entities/video.entity';
import { WorkerModule } from '../../src/worker/worker.module';
import {
  closeVideosE2eApp,
  createVideosE2eApp,
  initiateUpload,
  type VideosE2eContext,
} from '../support/videos-e2e';

const execFileAsync = promisify(execFile);

/** Hard cap of the test upload limit (`VIDEO_MAX_UPLOAD_BYTES` in `setup-test-env`). */
const TEST_UPLOAD_CEILING_BYTES = 12 * 1024 * 1024;
/** Two 5 MiB parts: a file must be larger than this to need a third part. */
const TWO_PARTS_BYTES = 10 * 1024 * 1024;
const POLL_INTERVAL_MS = 250;

/** The HTTP app and the worker, booted in the same Jest process (per TD-14). */
export interface VideoPipelineContext extends VideosE2eContext {
  worker: TestingModule;
}

/**
 * Boots the HTTP app (same globals as the other video e2e suites) and then the
 * `WorkerModule`, both on the Jest queue prefix `test` and the `-test` buckets.
 */
export async function startVideoPipeline(): Promise<VideoPipelineContext> {
  const ctx = await createVideosE2eApp();
  const worker = await Test.createTestingModule({
    imports: [WorkerModule],
  }).compile();
  await worker.init();
  return { ...ctx, worker };
}

/**
 * Stops consuming first (wipes the test queues and closes the worker), so no
 * job writes after the cleanup; then wipes the tables while the app's
 * `DataSource` is still open, empties the test buckets and closes the app.
 */
export async function stopVideoPipeline(
  ctx: VideoPipelineContext,
): Promise<void> {
  try {
    try {
      await obliterateTestQueues(ctx.worker);
    } finally {
      // Close the consumers even if the wipe fails, or they keep writing to
      // the DB while the app closes underneath them.
      await ctx.worker.close();
    }
    await cleanAllTables(ctx.dataSource);
  } finally {
    await closeVideosE2eApp(ctx);
  }
}

/**
 * Generates a ~11 MiB h264 video (`testsrc` + noise at a fixed 8 Mbit/s) with
 * `-fs 11M`. The muxer writes the `moov` index after the limit, so the file
 * ends a little past it. Fails early unless the result needs exactly three
 * 5 MiB parts and stays under the 12 MiB test ceiling.
 */
export async function generatePipelineVideo(): Promise<string> {
  const filePath = join(tmpdir(), `streamtube-pipeline-${randomUUID()}.mp4`);
  // prettier-ignore
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
    '-vf', 'noise=alls=60:allf=t',
    '-t', '60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-b:v', '8M', '-minrate', '8M', '-maxrate', '8M', '-bufsize', '2M',
    '-fs', '11M',
    filePath,
  ]);

  const { size } = await stat(filePath);
  if (size >= TEST_UPLOAD_CEILING_BYTES || size <= TWO_PARTS_BYTES) {
    await rm(filePath, { force: true });
    throw new Error(
      `Generated pipeline video has ${size} bytes; expected more than ${TWO_PARTS_BYTES} and less than ${TEST_UPLOAD_CEILING_BYTES}`,
    );
  }
  return filePath;
}

/** Size of the file on disk: the `sizeBytes` of every initiate comes from here. */
export async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

/** PUTs each part's byte range of the file straight to its presigned URL. */
export async function putFileParts(
  filePath: string,
  partSize: number,
  parts: PartUrlDto[],
): Promise<void> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    for (const { partNumber, url } of parts) {
      const start = (partNumber - 1) * partSize;
      const length = Math.min(partSize, size - start);
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, start);

      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(chunk),
      });
      if (res.status !== 200) {
        throw new Error(`PUT of part ${partNumber} answered ${res.status}`);
      }
    }
  } finally {
    await handle.close();
  }
}

/**
 * Initiates an upload and PUTs the file through the presigned part URLs of the
 * first batch. `stopAfterPart` simulates a pause: later parts are not sent.
 */
export async function uploadViaPresignedParts(
  app: INestApplication<App>,
  accessToken: string,
  initiateBody: Record<string, unknown>,
  filePath: string,
  { stopAfterPart }: { stopAfterPart?: number } = {},
): Promise<InitiateUploadResponseDto> {
  const initiated = await initiateUpload(app, accessToken, initiateBody);
  const parts =
    stopAfterPart === undefined
      ? initiated.parts
      : initiated.parts.filter((part) => part.partNumber <= stopAfterPart);
  await putFileParts(filePath, initiated.partSize, parts);
  return initiated;
}

/**
 * Polls `GET /videos/:id` until the video reaches `status`. Stops early on any
 * other final status, so a pipeline failure shows its `failureReason` instead
 * of a timeout.
 */
export async function waitForStatus(
  app: INestApplication<App>,
  accessToken: string,
  videoId: string,
  status: VideoProcessingStatus,
  timeoutMs: number,
): Promise<VideoResponseDto> {
  const finalStatuses = [
    VideoProcessingStatus.READY,
    VideoProcessingStatus.FAILED,
  ];
  const deadline = Date.now() + timeoutMs;
  let video: VideoResponseDto;
  do {
    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    video = res.body as VideoResponseDto;
    if (video.processingStatus === status) return video;
    if (finalStatuses.includes(video.processingStatus)) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (Date.now() < deadline);

  throw new Error(
    `Video ${videoId} is "${video.processingStatus}" (failureReason: ${video.failureReason}), expected "${status}" within ${timeoutMs} ms`,
  );
}

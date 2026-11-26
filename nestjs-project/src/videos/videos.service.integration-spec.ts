import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { obliterateTestQueues } from '../test/queues';
import { resetVideoTestBuckets } from '../test/storage';
import { User } from '../users/entities/user.entity';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './entities/video.entity';
import * as publicIdUtil from './public-id.util';
import {
  ActiveUploadLimitReachedException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from './videos.exceptions';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 5;

/** PUTs `size` bytes straight to a presigned part URL, like the browser does. */
async function putPart(url: string, size: number): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(Buffer.alloc(size, 1)),
  });
  expect(response.status).toBe(200);
}

describe('VideosService (integration, Postgres + MinIO + Redis)', () => {
  let moduleRef: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let processingQueue: Queue;

  async function createUserWithChannel(
    label: string,
  ): Promise<{ userId: string; channelId: string }> {
    const user = await dataSource.getRepository(User).save({
      email: `${label}-${randomUUID()}@example.com`,
      password: 'hashed-password',
      is_confirmed: true,
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: label,
      nickname: `${label}-${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
    return { userId: user.id, channelId: channel.id };
  }

  function initiateDto(
    overrides: Partial<InitiateUploadDto> = {},
  ): InitiateUploadDto {
    return {
      fileName: 'clip.mp4',
      sizeBytes: 10 * MIB,
      mimeType: 'video/mp4',
      ...overrides,
    };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [videoConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    processingQueue = moduleRef.get<Queue>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  }, 30000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await obliterateTestQueues(moduleRef);
    await resetVideoTestBuckets(moduleRef);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // Free the storage space of multipart uploads the test left open.
    const open = await videoRepository.find({
      where: { upload_id: Not(IsNull()) },
    });
    for (const video of open) {
      await storage.abortMultipartUpload(
        video.source_key,
        video.upload_id as string,
      );
    }
  });

  describe('initiateUpload', () => {
    it('should persist an uploading/draft row with upload_id and open an empty multipart upload', async () => {
      const { userId, channelId } = await createUserWithChannel('owner');

      const result = await service.initiateUpload(userId, initiateDto());

      const row = await videoRepository.findOneByOrFail({
        id: result.videoId,
      });
      expect(row).toMatchObject({
        channel_id: channelId,
        public_id: result.publicId,
        processing_status: VideoProcessingStatus.UPLOADING,
        publication_status: VideoPublicationStatus.DRAFT,
        upload_id: result.uploadId,
        upload_part_size_bytes: 5 * MIB,
        size_bytes: 10 * MIB,
        source_key: `${result.videoId}/source`,
        title: 'clip',
        failure_reason: null,
      });
      await expect(
        storage.listAllParts(row.source_key, result.uploadId),
      ).resolves.toEqual([]);
    });

    it('should reject ACTIVE_UPLOAD_LIMIT_REACHED once the channel has the maximum of uploading videos', async () => {
      const { userId, channelId } = await createUserWithChannel('owner');
      for (let i = 0; i < MAX_ACTIVE_UPLOADS; i++) {
        await service.initiateUpload(userId, initiateDto());
      }

      await expect(
        service.initiateUpload(userId, initiateDto()),
      ).rejects.toBeInstanceOf(ActiveUploadLimitReachedException);
      await expect(
        videoRepository.countBy({ channel_id: channelId }),
      ).resolves.toBe(MAX_ACTIVE_UPLOADS);
    });

    it('should let only one of two concurrent initiations through when one slot is left', async () => {
      const { userId, channelId } = await createUserWithChannel('owner');
      for (let i = 0; i < MAX_ACTIVE_UPLOADS - 1; i++) {
        await service.initiateUpload(userId, initiateDto());
      }

      const results = await Promise.allSettled([
        service.initiateUpload(userId, initiateDto()),
        service.initiateUpload(userId, initiateDto()),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(
        ActiveUploadLimitReachedException,
      );
      await expect(
        videoRepository.countBy({
          channel_id: channelId,
          processing_status: VideoProcessingStatus.UPLOADING,
        }),
      ).resolves.toBe(MAX_ACTIVE_UPLOADS);
    });

    it('should redo a colliding public_id inside a SAVEPOINT and finish the insert in the same transaction', async () => {
      const { userId } = await createUserWithChannel('owner');
      const existing = await service.initiateUpload(userId, initiateDto());
      const generate = jest
        .spyOn(publicIdUtil, 'generatePublicId')
        .mockReturnValueOnce(existing.publicId);

      const result = await service.initiateUpload(userId, initiateDto());

      expect(generate).toHaveBeenCalledTimes(2);
      expect(result.publicId).not.toBe(existing.publicId);
      expect(result.publicId).toMatch(publicIdUtil.PUBLIC_ID_PATTERN);
      const row = await videoRepository.findOneByOrFail({
        id: result.videoId,
      });
      expect(row.public_id).toBe(result.publicId);
      await expect(videoRepository.count()).resolves.toBe(2);
    });
  });

  describe('signPartUrls', () => {
    it('should list a really uploaded part 1 and sign the missing parts from 2 on', async () => {
      const { userId } = await createUserWithChannel('owner');
      const initiated = await service.initiateUpload(
        userId,
        initiateDto({ sizeBytes: 12 * MIB }),
      );
      await putPart(initiated.parts[0].url, 5 * MIB);

      const result = await service.signPartUrls(initiated.videoId, userId, {});

      expect(result.uploadedParts).toHaveLength(1);
      expect(result.uploadedParts[0]).toMatchObject({
        partNumber: 1,
        size: 5 * MIB,
      });
      expect(result.uploadedParts[0].etag).toBeTruthy();
      expect(result.parts.map((part) => part.partNumber)).toEqual([2, 3]);
    });

    it('should advance updated_at', async () => {
      const { userId } = await createUserWithChannel('owner');
      const initiated = await service.initiateUpload(userId, initiateDto());
      const before = await videoRepository.findOneByOrFail({
        id: initiated.videoId,
      });

      await service.signPartUrls(initiated.videoId, userId, {});

      const after = await videoRepository.findOneByOrFail({
        id: initiated.videoId,
      });
      expect(after.updated_at.getTime()).toBeGreaterThan(
        before.updated_at.getTime(),
      );
    });

    it('should reject VIDEO_NOT_FOUND for a caller who does not own the video, leaving updated_at untouched', async () => {
      const owner = await createUserWithChannel('owner');
      const other = await createUserWithChannel('other');
      const initiated = await service.initiateUpload(
        owner.userId,
        initiateDto(),
      );
      const before = await videoRepository.findOneByOrFail({
        id: initiated.videoId,
      });

      await expect(
        service.signPartUrls(initiated.videoId, other.userId, {}),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      const after = await videoRepository.findOneByOrFail({
        id: initiated.videoId,
      });
      expect(after.updated_at).toEqual(before.updated_at);
    });
  });

  describe('completeUpload', () => {
    it('should complete the object with ContentType = mime_type, move the row to processing and enqueue process-video with jobId = videoId', async () => {
      const { userId } = await createUserWithChannel('owner');
      const initiated = await service.initiateUpload(
        userId,
        initiateDto({ sizeBytes: 10 * MIB, mimeType: 'video/webm' }),
      );
      await putPart(initiated.parts[1].url, 5 * MIB);
      await putPart(initiated.parts[0].url, 5 * MIB);

      const result = await service.completeUpload(initiated.videoId, userId);

      expect(result.processingStatus).toBe(VideoProcessingStatus.PROCESSING);
      const row = await videoRepository.findOneByOrFail({
        id: initiated.videoId,
      });
      expect(row.processing_status).toBe(VideoProcessingStatus.PROCESSING);
      expect(row.upload_id).toBeNull();
      await expect(
        storage.headObject('videos-test', row.source_key),
      ).resolves.toEqual({
        contentLength: 10 * MIB,
        contentType: 'video/webm',
      });

      const job = await processingQueue.getJob(initiated.videoId);
      expect(job?.name).toBe(PROCESS_VIDEO_JOB);
      expect(job?.data).toEqual({ videoId: initiated.videoId });
      expect(processingQueue.opts.prefix).toBe('test');
    });

    it('should reject UPLOAD_SIZE_MISMATCH when the stored parts add up to less than sizeBytes, keeping the row uploading', async () => {
      const { userId } = await createUserWithChannel('owner');
      const initiated = await service.initiateUpload(
        userId,
        initiateDto({ sizeBytes: 2048 }),
      );
      await putPart(initiated.parts[0].url, 1024);

      await expect(
        service.completeUpload(initiated.videoId, userId),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      const row = await videoRepository.findOneByOrFail({
        id: initiated.videoId,
      });
      expect(row.processing_status).toBe(VideoProcessingStatus.UPLOADING);
      expect(row.upload_id).toBe(initiated.uploadId);
      expect(row.failure_reason).toBeNull();
      await expect(
        processingQueue.getJob(initiated.videoId),
      ).resolves.toBeUndefined();
    });

    it('should reject UPLOAD_SIZE_MISMATCH (never a storage 500) for parts of 4 MiB + 6 MiB in a 10 MiB upload', async () => {
      const { userId } = await createUserWithChannel('owner');
      const initiated = await service.initiateUpload(
        userId,
        initiateDto({ sizeBytes: 10 * MIB }),
      );
      await putPart(initiated.parts[0].url, 4 * MIB);
      await putPart(initiated.parts[1].url, 6 * MIB);

      await expect(
        service.completeUpload(initiated.videoId, userId),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      const row = await videoRepository.findOneByOrFail({
        id: initiated.videoId,
      });
      expect(row.processing_status).toBe(VideoProcessingStatus.UPLOADING);
      expect(row.upload_id).toBe(initiated.uploadId);
    });
  });

  describe('abortUpload', () => {
    it('should mark the row failed/UPLOAD_ABORTED with a null upload_id and abort the multipart upload in storage', async () => {
      const { userId } = await createUserWithChannel('owner');
      const initiated = await service.initiateUpload(userId, initiateDto());
      await putPart(initiated.parts[0].url, 5 * MIB);

      await service.abortUpload(initiated.videoId, userId);

      const row = await videoRepository.findOneByOrFail({
        id: initiated.videoId,
      });
      expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
      expect(row.failure_reason).toBe('UPLOAD_ABORTED');
      expect(row.upload_id).toBeNull();
      await expect(
        storage.listAllParts(row.source_key, initiated.uploadId),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });

    it('should let a channel at the active-upload limit start a new upload right after an abort', async () => {
      const { userId } = await createUserWithChannel('owner');
      const initiated: { videoId: string }[] = [];
      for (let i = 0; i < MAX_ACTIVE_UPLOADS; i++) {
        initiated.push(await service.initiateUpload(userId, initiateDto()));
      }
      await expect(
        service.initiateUpload(userId, initiateDto()),
      ).rejects.toBeInstanceOf(ActiveUploadLimitReachedException);

      await service.abortUpload(initiated[0].videoId, userId);

      await expect(
        service.initiateUpload(userId, initiateDto()),
      ).resolves.toMatchObject({ partCount: 2 });
    });
  });
});

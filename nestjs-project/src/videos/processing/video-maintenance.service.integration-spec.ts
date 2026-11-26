import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError, Worker, type Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  processVideoJobOptions,
  type ProcessVideoJobData,
} from '../../queue/queue.constants';
import { QueueModule } from '../../queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { obliterateTestQueues } from '../../test/queues';
import { TEST_ENV_OVERRIDES } from '../../test/setup-test-env';
import { resetVideoTestBuckets } from '../../test/storage';
import { ageVideo, createChannel, insertVideo } from '../../test/videos';
import { User } from '../../users/entities/user.entity';
import {
  Video,
  VideoFailureReason,
  VideoProcessingStatus,
} from '../entities/video.entity';
import { VideoMaintenanceService } from './video-maintenance.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const ONE_MINUTE_MS = 60000;
const FAILED_JOB_TIMEOUT_MS = 10000;

describe('VideoMaintenanceService (integration, Postgres + MinIO + Redis)', () => {
  let moduleRef: TestingModule;
  let service: VideoMaintenanceService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let processingQueue: Queue<ProcessVideoJobData>;
  let config: ConfigType<typeof videoConfig>;
  let channelId: string;

  /** An `uploading` row with a real open multipart upload. */
  async function seedUpload(): Promise<Video> {
    const video = await insertVideo(dataSource, channelId, {
      processing_status: VideoProcessingStatus.UPLOADING,
    });
    const uploadId = await storage.createMultipartUpload(
      video.source_key,
      'video/mp4',
    );
    await videoRepository.update({ id: video.id }, { upload_id: uploadId });
    return videoRepository.findOneByOrFail({ id: video.id });
  }

  /** Makes `process-video` for `videoId` end in BullMQ's `failed` state. */
  async function failJobFor(videoId: string): Promise<void> {
    const queue = moduleRef.get<ConfigType<typeof queueConfig>>(
      queueConfig.KEY,
    );
    const worker = new Worker(
      VIDEO_PROCESSING_QUEUE,
      () => Promise.reject(new UnrecoverableError('simulated failure')),
      {
        connection: { host: queue.host, port: queue.port },
        prefix: queue.prefix,
      },
    );
    try {
      await processingQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId },
        processVideoJobOptions(videoId),
      );
      const deadline = Date.now() + FAILED_JOB_TIMEOUT_MS;
      while (
        (await processingQueue.getJobState(videoId)) !== 'failed' &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await worker.close();
    }
    expect(await processingQueue.getJobState(videoId)).toBe('failed');
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [videoConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        QueueModule,
      ],
      providers: [VideoMaintenanceService],
    }).compile();

    service = moduleRef.get(VideoMaintenanceService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    videoRepository = moduleRef.get(getRepositoryToken(Video));
    processingQueue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    config = moduleRef.get(videoConfig.KEY);
    expect(processingQueue.opts.prefix).toBe(TEST_ENV_OVERRIDES.QUEUE_PREFIX);
  }, 30000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await obliterateTestQueues(moduleRef);
    await resetVideoTestBuckets(moduleRef);
    await moduleRef.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    await processingQueue.obliterate({ force: true });
    channelId = (await createChannel(dataSource)).id;
  });

  describe('sweepStaleUploads', () => {
    it('should fail an abandoned upload with UPLOAD_ABANDONED and abort its multipart', async () => {
      const stale = await seedUpload();
      const recent = await seedUpload();
      await ageVideo(
        dataSource,
        stale.id,
        config.uploadStaleAfterMs + ONE_MINUTE_MS,
      );

      const result = await service.sweepStaleUploads();

      expect(result).toEqual({ abandoned: 1, errors: 0 });
      const row = await videoRepository.findOneByOrFail({ id: stale.id });
      expect(row).toMatchObject({
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: VideoFailureReason.UPLOAD_ABANDONED,
        upload_id: null,
      });
      await expect(
        storage.listAllParts(stale.source_key, stale.upload_id!),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });

      const untouched = await videoRepository.findOneByOrFail({
        id: recent.id,
      });
      expect(untouched.processing_status).toBe(VideoProcessingStatus.UPLOADING);
      await expect(
        storage.listAllParts(recent.source_key, recent.upload_id!),
      ).resolves.toEqual([]);
    });

    it('should not abort the multipart when a concurrent complete wins the claim', async () => {
      const stale = await seedUpload();
      await ageVideo(
        dataSource,
        stale.id,
        config.uploadStaleAfterMs + ONE_MINUTE_MS,
      );
      // The sweep selected the row as `uploading`, then `complete` moved it on.
      const snapshot = await videoRepository.findOneByOrFail({ id: stale.id });
      jest.spyOn(videoRepository, 'find').mockResolvedValueOnce([snapshot]);
      await videoRepository.update(
        { id: stale.id },
        { processing_status: VideoProcessingStatus.PROCESSING },
      );

      const result = await service.sweepStaleUploads();

      expect(result).toEqual({ abandoned: 0, errors: 0 });
      const row = await videoRepository.findOneByOrFail({ id: stale.id });
      expect(row.processing_status).toBe(VideoProcessingStatus.PROCESSING);
      expect(row.failure_reason).toBeNull();
      await expect(
        storage.listAllParts(stale.source_key, stale.upload_id!),
      ).resolves.toEqual([]);
    });
  });

  describe('sweepOrphanedProcessing', () => {
    it('should re-enqueue process-video with jobId = videoId for an orphaned row', async () => {
      const orphan = await insertVideo(dataSource, channelId);
      const recent = await insertVideo(dataSource, channelId);
      await ageVideo(
        dataSource,
        orphan.id,
        config.sweepIntervalMs + ONE_MINUTE_MS,
      );

      const result = await service.sweepOrphanedProcessing();

      expect(result).toEqual({ requeued: 1, failed: 0, errors: 0 });
      const job = await processingQueue.getJob(orphan.id);
      expect(job).toMatchObject({
        id: orphan.id,
        name: PROCESS_VIDEO_JOB,
        data: { videoId: orphan.id },
      });
      expect(job?.opts).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
      await expect(processingQueue.getJob(recent.id)).resolves.toBeUndefined();
      const row = await videoRepository.findOneByOrFail({ id: orphan.id });
      expect(row.processing_status).toBe(VideoProcessingStatus.PROCESSING);
    });

    it('should fail the row with PROCESSING_ERROR when its job is failed in BullMQ', async () => {
      const video = await insertVideo(dataSource, channelId);
      await failJobFor(video.id);
      await ageVideo(
        dataSource,
        video.id,
        config.sweepIntervalMs + ONE_MINUTE_MS,
      );

      const result = await service.sweepOrphanedProcessing();

      expect(result).toEqual({ requeued: 0, failed: 1, errors: 0 });
      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
      expect(row.failure_reason).toBe(VideoFailureReason.PROCESSING_ERROR);
    });

    it('should leave a row alone while its job is still waiting', async () => {
      const video = await insertVideo(dataSource, channelId);
      await processingQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId: video.id },
        processVideoJobOptions(video.id),
      );
      await ageVideo(
        dataSource,
        video.id,
        config.sweepIntervalMs + ONE_MINUTE_MS,
      );

      const result = await service.sweepOrphanedProcessing();

      expect(result).toEqual({ requeued: 0, failed: 0, errors: 0 });
      await expect(processingQueue.getJobState(video.id)).resolves.toBe(
        'waiting',
      );
      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.processing_status).toBe(VideoProcessingStatus.PROCESSING);
    });
  });
});

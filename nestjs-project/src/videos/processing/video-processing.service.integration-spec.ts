import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
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
import { resetVideoTestBuckets } from '../../test/storage';
import { createChannel, insertVideo } from '../../test/videos';
import { User } from '../../users/entities/user.entity';
import {
  Video,
  VideoFailureReason,
  VideoProcessingStatus,
} from '../entities/video.entity';
import { MediaToolTransientError } from './media-tools.errors';
import { MediaToolsService } from './media-tools.service';
import { THUMBNAIL_TMP_PREFIX } from './processing.constants';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const REAL_QUEUE_TIMEOUT_MS = 20000;

function firstAttempt(videoId: string): Job<ProcessVideoJobData> {
  return {
    data: { videoId },
    attemptsStarted: 1,
    opts: { attempts: 3 },
  } as Job<ProcessVideoJobData>;
}

async function leftoverFrames(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((name) => name.startsWith(THUMBNAIL_TMP_PREFIX));
}

describe('VideoProcessingService (integration, Postgres + MinIO + ffprobe/ffmpeg)', () => {
  let moduleRef: TestingModule;
  let consumer: VideoProcessingConsumer;
  let mediaTools: MediaToolsService;
  let storage: StorageService;
  let buckets: ConfigType<typeof storageConfig>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelId: string;

  /** A video row in `status` whose source object holds `fixture` (or nothing). */
  async function seedVideo(
    status: VideoProcessingStatus,
    fixture: string | null,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const video = await insertVideo(dataSource, channelId, {
      processing_status: status,
      ...overrides,
    });
    if (fixture) {
      await storage.putObject(
        buckets.videosBucket,
        video.source_key,
        await readFile(join(FIXTURES_DIR, fixture)),
        'video/mp4',
      );
    }
    return video;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        QueueModule,
      ],
      providers: [
        MediaToolsService,
        VideoProcessingService,
        VideoProcessingConsumer,
      ],
    }).compile();
    // Starts the BullMQ worker of the consumer (Jest "test" prefix).
    await moduleRef.init();

    consumer = moduleRef.get(VideoProcessingConsumer);
    mediaTools = moduleRef.get(MediaToolsService);
    storage = moduleRef.get(StorageService);
    buckets = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
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
    channelId = (await createChannel(dataSource)).id;
  });

  it('should make a valid video ready with its metadata and a public JPEG thumbnail', async () => {
    const video = await seedVideo(
      VideoProcessingStatus.PROCESSING,
      'sample-2s.mp4',
    );

    await consumer.process(firstAttempt(video.id));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      processing_status: VideoProcessingStatus.READY,
      failure_reason: null,
      width: 160,
      height: 120,
      video_codec: 'h264',
      audio_codec: 'aac',
      thumbnail_key: `${video.id}/default.jpg`,
    });
    expect(row.duration_seconds).toBeCloseTo(2, 1);
    expect(row.format_name).toContain('mp4');
    expect(row.processed_at).toBeInstanceOf(Date);

    const thumbnail = await fetch(
      storage.publicObjectUrl(buckets.thumbnailsBucket, row.thumbnail_key!),
    );
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await thumbnail.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(await leftoverFrames()).toEqual([]);
  });

  it('should fail an invalid source with INVALID_MEDIA, without retries', async () => {
    const video = await seedVideo(
      VideoProcessingStatus.PROCESSING,
      'not-a-video.mp4',
    );

    await expect(
      consumer.process(firstAttempt(video.id)),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.failure_reason).toBe(VideoFailureReason.INVALID_MEDIA);
    expect(row.thumbnail_key).toBeNull();
    expect(await leftoverFrames()).toEqual([]);
  });

  it('should fail a video whose source object is missing with PROCESSING_ERROR', async () => {
    const video = await seedVideo(VideoProcessingStatus.PROCESSING, null);

    await expect(
      consumer.process(firstAttempt(video.id)),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.failure_reason).toBe(VideoFailureReason.PROCESSING_ERROR);
  });

  it('should overwrite metadata and thumbnail when re-run on a ready video', async () => {
    const video = await seedVideo(
      VideoProcessingStatus.READY,
      'sample-2s.mp4',
      {
        width: 1,
        height: 1,
        video_codec: 'stale',
        processed_at: new Date('2020-01-01T00:00:00Z'),
      },
    );

    await consumer.process(firstAttempt(video.id));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      processing_status: VideoProcessingStatus.READY,
      width: 160,
      height: 120,
      video_codec: 'h264',
      thumbnail_key: `${video.id}/default.jpg`,
    });
    expect(row.processed_at!.getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00Z').getTime(),
    );
    await expect(
      storage.headObject(buckets.thumbnailsBucket, row.thumbnail_key!),
    ).resolves.toMatchObject({ contentType: 'image/jpeg' });
  });

  it.each([
    [VideoProcessingStatus.FAILED, VideoFailureReason.UPLOAD_ABORTED],
    [VideoProcessingStatus.UPLOADING, null],
  ])(
    'should leave a %s row untouched (no-op job)',
    async (status, failureReason) => {
      const video = await seedVideo(status, 'sample-2s.mp4', {
        failure_reason: failureReason,
      });

      await consumer.process(firstAttempt(video.id));

      const row = await videoRepository.findOneByOrFail({ id: video.id });
      expect(row.processing_status).toBe(status);
      expect(row.failure_reason).toBe(failureReason);
      expect(row.thumbnail_key).toBeNull();
      expect(row.processed_at).toBeNull();
      await expect(
        storage.headObject(buckets.thumbnailsBucket, `${video.id}/default.jpg`),
      ).resolves.toBeNull();
    },
  );

  it('should not resurrect a row that was failed while the job was running', async () => {
    const video = await seedVideo(
      VideoProcessingStatus.PROCESSING,
      'sample-2s.mp4',
    );
    // Stateless wrapper without dependencies: a second instance runs the real ffprobe.
    const realTools = new MediaToolsService();
    jest.spyOn(mediaTools, 'probe').mockImplementation(async (input) => {
      await videoRepository.update(
        { id: video.id },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: VideoFailureReason.PROCESSING_ERROR,
        },
      );
      return realTools.probe(input);
    });

    await consumer.process(firstAttempt(video.id));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.failure_reason).toBe(VideoFailureReason.PROCESSING_ERROR);
    expect(row.processed_at).toBeNull();
  });

  it('should keep the video processing and remove the local frame when the thumbnail upload fails transiently', async () => {
    const video = await seedVideo(
      VideoProcessingStatus.PROCESSING,
      'sample-2s.mp4',
    );
    const uploadError = new Error('socket hang up');
    jest.spyOn(storage, 'putObject').mockRejectedValueOnce(uploadError);

    await expect(consumer.process(firstAttempt(video.id))).rejects.toBe(
      uploadError,
    );

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.PROCESSING);
    expect(row.failure_reason).toBeNull();
    expect(await leftoverFrames()).toEqual([]);
  });

  it('should fail PROCESSING_ERROR on the last attempt of a persistent transient error', async () => {
    const video = await seedVideo(
      VideoProcessingStatus.PROCESSING,
      'sample-2s.mp4',
    );
    jest
      .spyOn(mediaTools, 'probe')
      .mockRejectedValue(new MediaToolTransientError('ffprobe timed out'));

    await expect(
      consumer.process({
        ...firstAttempt(video.id),
        attemptsStarted: 3,
      } as Job<ProcessVideoJobData>),
    ).rejects.toBeInstanceOf(MediaToolTransientError);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(row.failure_reason).toBe(VideoFailureReason.PROCESSING_ERROR);
  });

  it('should move a real invalid-media job to failed after a single attempt', async () => {
    const video = await seedVideo(
      VideoProcessingStatus.PROCESSING,
      'not-a-video.mp4',
    );
    const queue = moduleRef.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );

    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id },
      processVideoJobOptions(video.id),
    );

    const deadline = Date.now() + REAL_QUEUE_TIMEOUT_MS;
    let state = await queue.getJobState(video.id);
    while (state !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await queue.getJobState(video.id);
    }
    const job = await queue.getJob(video.id);
    expect(state).toBe('failed');
    expect(job?.attemptsMade).toBe(1);
    expect(job?.failedReason).toContain('INVALID_MEDIA');
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.failure_reason).toBe(VideoFailureReason.INVALID_MEDIA);
  }, 30000);
});

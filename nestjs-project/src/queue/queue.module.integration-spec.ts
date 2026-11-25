import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { obliterateTestQueues } from '../test/queues';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
  processVideoJobOptions,
  type ProcessVideoJobData,
} from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule (integration, Redis)', () => {
  let moduleRef: TestingModule;
  let processingQueue: Queue<ProcessVideoJobData>;
  let maintenanceQueue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    processingQueue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    maintenanceQueue = moduleRef.get(getQueueToken(VIDEO_MAINTENANCE_QUEUE));
  });

  afterAll(async () => {
    await obliterateTestQueues(moduleRef);
    await moduleRef.close();
  });

  it('should resolve both video queues with the Jest "test" prefix', () => {
    expect(processingQueue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(maintenanceQueue.name).toBe(VIDEO_MAINTENANCE_QUEUE);
    expect(processingQueue.opts.prefix).toBe('test');
    expect(maintenanceQueue.opts.prefix).toBe('test');
  });

  it('should store process-video jobs under test:video-processing:*, never bull:*', async () => {
    const videoId = randomUUID();

    await processingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      processVideoJobOptions(videoId),
    );

    // bullmq 6 keeps the raw Redis client on the (default Redis) backend.
    // A job is a Redis hash at `<prefix>:<queue>:<jobId>`.
    const redis = await processingQueue.getBackend().client;
    await expect(
      redis.hget(`test:${VIDEO_PROCESSING_QUEUE}:${videoId}`, 'name'),
    ).resolves.toBe(PROCESS_VIDEO_JOB);
    await expect(
      redis.hget(`bull:${VIDEO_PROCESSING_QUEUE}:${videoId}`, 'name'),
    ).resolves.toBeNull();
  });

  it('should deduplicate process-video jobs by jobId', async () => {
    const videoId = randomUUID();
    const options = processVideoJobOptions(videoId);

    const first = await processingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      options,
    );
    const second = await processingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      options,
    );

    expect(first.id).toBe(videoId);
    expect(second.id).toBe(videoId);
    const waiting = await processingQueue.getJobs(['waiting']);
    expect(waiting.filter((job) => job.id === videoId)).toHaveLength(1);
  });

  it('should carry the retry policy of the process-video contract', async () => {
    const videoId = randomUUID();

    const job = await processingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      processVideoJobOptions(videoId),
    );

    expect(job.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: { count: 1000 },
    });
  });

  it('should have no worker attached when only the producer side is loaded', async () => {
    await expect(processingQueue.getWorkersCount()).resolves.toBe(0);
  });
});

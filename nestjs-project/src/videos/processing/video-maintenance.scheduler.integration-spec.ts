import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import videoConfig from '../../config/video.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_MAINTENANCE_SCHEDULER_ID,
  VIDEO_MAINTENANCE_SWEEP_JOB,
} from '../../queue/queue.constants';
import { QueueModule } from '../../queue/queue.module';
import { obliterateTestQueues } from '../../test/queues';
import { VideoMaintenanceScheduler } from './video-maintenance.scheduler';

/** The queue module alone, optionally with the scheduler (one worker "replica"). */
async function bootModule(withScheduler: boolean): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [queueConfig, videoConfig],
      }),
      QueueModule,
    ],
    providers: withScheduler ? [VideoMaintenanceScheduler] : [],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('VideoMaintenanceScheduler (integration, Redis)', () => {
  let observer: TestingModule;
  let queue: Queue;
  const replicas: TestingModule[] = [];

  beforeAll(async () => {
    observer = await bootModule(false);
    queue = observer.get<Queue>(getQueueToken(VIDEO_MAINTENANCE_QUEUE));
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    for (const replica of replicas) await replica.close();
    await obliterateTestQueues(observer);
    await observer.close();
  });

  it('should keep a single video-maintenance-sweep scheduler across two bootstraps', async () => {
    replicas.push(await bootModule(true));
    replicas.push(await bootModule(true));

    const { sweepIntervalMs } = observer.get<ConfigType<typeof videoConfig>>(
      videoConfig.KEY,
    );
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: VIDEO_MAINTENANCE_SCHEDULER_ID,
      name: VIDEO_MAINTENANCE_SWEEP_JOB,
      every: sweepIntervalMs,
    });
    const pending = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(pending.map((job) => job.name)).toEqual([
      VIDEO_MAINTENANCE_SWEEP_JOB,
    ]);
  });
});

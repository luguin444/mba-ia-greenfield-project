import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import videoConfig from '../../config/video.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_MAINTENANCE_SCHEDULER_ID,
  VIDEO_MAINTENANCE_SWEEP_JOB,
} from '../../queue/queue.constants';

/**
 * Declares the maintenance Job Scheduler when the worker boots. `upsert` is
 * idempotent by scheduler id, so restarts and extra replicas keep a single
 * scheduler. The API never declares it (it does not import this provider).
 */
@Injectable()
export class VideoMaintenanceScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoMaintenanceScheduler.name);

  constructor(
    @InjectQueue(VIDEO_MAINTENANCE_QUEUE)
    private readonly maintenanceQueue: Queue,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.maintenanceQueue.upsertJobScheduler(
      VIDEO_MAINTENANCE_SCHEDULER_ID,
      { every: this.config.sweepIntervalMs },
      { name: VIDEO_MAINTENANCE_SWEEP_JOB, data: {}, opts: { attempts: 1 } },
    );
    this.logger.log(
      `Job Scheduler "${VIDEO_MAINTENANCE_SCHEDULER_ID}" every ${this.config.sweepIntervalMs} ms`,
    );
  }
}

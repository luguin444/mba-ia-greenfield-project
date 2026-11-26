import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { VIDEO_MAINTENANCE_QUEUE } from '../../queue/queue.constants';
import {
  VideoMaintenanceService,
  type OrphanedProcessingSweepResult,
  type StaleUploadsSweepResult,
} from './video-maintenance.service';

export interface MaintenanceSweepResult {
  staleUploads: StaleUploadsSweepResult;
  orphanedProcessing: OrphanedProcessingSweepResult;
}

/**
 * Runs one maintenance tick per `sweep` job (worker only). `concurrency: 1`
 * keeps ticks from overlapping inside a worker; a failed tick is not retried
 * (`attempts: 1`) because the next one covers it.
 */
@Processor(VIDEO_MAINTENANCE_QUEUE, { concurrency: 1 })
export class VideoMaintenanceConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoMaintenanceConsumer.name);

  constructor(private readonly maintenanceService: VideoMaintenanceService) {
    super();
  }

  async process(): Promise<MaintenanceSweepResult> {
    const staleUploads = await this.maintenanceService.sweepStaleUploads();
    const orphanedProcessing =
      await this.maintenanceService.sweepOrphanedProcessing();
    this.logger.log(
      `Sweep done: ${staleUploads.abandoned} abandoned upload(s), ` +
        `${orphanedProcessing.requeued} re-enqueued, ${orphanedProcessing.failed} failed, ` +
        `${staleUploads.errors + orphanedProcessing.errors} row error(s)`,
    );
    return { staleUploads, orphanedProcessing };
  }

  @OnWorkerEvent('ready')
  onReady(): void {
    this.logger.log(`Consuming "${VIDEO_MAINTENANCE_QUEUE}"`);
  }
}

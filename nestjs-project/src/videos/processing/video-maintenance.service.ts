import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Raw, Repository } from 'typeorm';
import videoConfig from '../../config/video.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  processVideoJobOptions,
  type ProcessVideoJobData,
} from '../../queue/queue.constants';
import { StorageService } from '../../storage/storage.service';
import {
  Video,
  VideoFailureReason,
  VideoProcessingStatus,
} from '../entities/video.entity';
import { SWEEP_BATCH_SIZE } from './processing.constants';

export interface StaleUploadsSweepResult {
  abandoned: number;
  errors: number;
}

export interface OrphanedProcessingSweepResult {
  requeued: number;
  failed: number;
  errors: number;
}

/**
 * The two halves of the periodic maintenance tick (worker only):
 * - stale uploads: `uploading` rows with no activity are failed as
 *   `UPLOAD_ABANDONED` and their multipart upload is aborted (storage cost);
 * - orphaned processing: `processing` rows whose `process-video` job was lost
 *   (non-transactional enqueue after `complete`) are re-enqueued, and rows
 *   whose job already failed are failed as `PROCESSING_ERROR`.
 *
 * Each row is handled on its own: an error is logged and the batch goes on,
 * and the next tick retries whatever is still selected.
 */
@Injectable()
export class VideoMaintenanceService {
  private readonly logger = new Logger(VideoMaintenanceService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async sweepStaleUploads(): Promise<StaleUploadsSweepResult> {
    const rows = await this.findInactive(
      VideoProcessingStatus.UPLOADING,
      this.config.uploadStaleAfterMs,
    );
    const result: StaleUploadsSweepResult = { abandoned: 0, errors: 0 };
    for (const video of rows) {
      try {
        if (await this.abandonUpload(video)) result.abandoned++;
      } catch (error) {
        result.errors++;
        this.logRowError('abandon stale upload', video.id, error);
      }
    }
    return result;
  }

  async sweepOrphanedProcessing(): Promise<OrphanedProcessingSweepResult> {
    // One sweep interval of grace, so the API's post-commit enqueue is not raced.
    const rows = await this.findInactive(
      VideoProcessingStatus.PROCESSING,
      this.config.sweepIntervalMs,
    );
    const result: OrphanedProcessingSweepResult = {
      requeued: 0,
      failed: 0,
      errors: 0,
    };
    for (const video of rows) {
      try {
        const outcome = await this.reconcileProcessing(video.id);
        if (outcome === 'requeued') result.requeued++;
        if (outcome === 'failed') result.failed++;
      } catch (error) {
        result.errors++;
        this.logRowError('reconcile processing', video.id, error);
      }
    }
    return result;
  }

  /**
   * Claims the row first; the multipart is aborted only when this sweep won
   * the claim. A concurrent `complete` that already moved the row keeps its
   * upload (its own transition is conditional on `uploading` too).
   */
  private async abandonUpload(video: Video): Promise<boolean> {
    const claim = await this.videoRepository.update(
      { id: video.id, processing_status: VideoProcessingStatus.UPLOADING },
      {
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: VideoFailureReason.UPLOAD_ABANDONED,
        upload_id: null,
      },
    );
    if (!claim.affected) return false;
    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.source_key,
        video.upload_id,
      );
    }
    return true;
  }

  private async reconcileProcessing(
    videoId: string,
  ): Promise<'requeued' | 'failed' | 'in-flight'> {
    const job = await this.processingQueue.getJob(videoId);
    if (!job) {
      await this.processingQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId },
        processVideoJobOptions(videoId),
      );
      return 'requeued';
    }
    // A failed job keeps its id, so re-adding it would be a no-op: fail the row.
    if ((await job.getState()) === 'failed') {
      await this.videoRepository.update(
        { id: videoId, processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: VideoFailureReason.PROCESSING_ERROR,
        },
      );
      return 'failed';
    }
    return 'in-flight';
  }

  /** Oldest first, compared with the DB clock (`updated_at` is written by it). */
  private findInactive(
    status: VideoProcessingStatus,
    inactiveForMs: number,
  ): Promise<Video[]> {
    return this.videoRepository.find({
      where: {
        processing_status: status,
        updated_at: Raw(
          (column) =>
            `${column} < now() - make_interval(secs => :inactiveSeconds)`,
          { inactiveSeconds: inactiveForMs / 1000 },
        ),
      },
      order: { updated_at: 'ASC' },
      take: SWEEP_BATCH_SIZE,
    });
  }

  /** Background job: log and keep sweeping; the next tick retries the row. */
  private logRowError(action: string, videoId: string, error: unknown): void {
    this.logger.error(
      `Could not ${action} for video ${videoId}: ${(error as Error).message}`,
      (error as Error).stack,
    );
  }
}

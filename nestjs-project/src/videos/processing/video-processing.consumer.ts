import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../../queue/queue.constants';
import { VideoFailureReason } from '../entities/video.entity';
import { InvalidMediaError } from './media-tools.errors';
import { SourceObjectMissingError } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';

/** The failure reason of a permanent error, or `null` for a transient one. */
function permanentFailureReason(error: unknown): VideoFailureReason | null {
  if (error instanceof InvalidMediaError) {
    return VideoFailureReason.INVALID_MEDIA;
  }
  if (error instanceof SourceObjectMissingError) {
    return VideoFailureReason.PROCESSING_ERROR;
  }
  return null;
}

/**
 * Consumes `process-video` (worker process only). Permanent errors fail the
 * video and the job at once (`UnrecoverableError` skips the remaining
 * attempts). Transient errors are rethrown for the exponential backoff, and on
 * the last attempt the video is failed with `PROCESSING_ERROR` first.
 */
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 2 })
export class VideoProcessingConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingConsumer.name);

  constructor(private readonly processingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    try {
      await this.processingService.process(videoId);
    } catch (error) {
      const reason = permanentFailureReason(error);
      if (reason) {
        await this.processingService.markFailed(videoId, reason);
        throw new UnrecoverableError(`${reason}: ${(error as Error).message}`);
      }
      // `attemptsStarted` already counts the attempt that is running now.
      if (job.attemptsStarted >= (job.opts.attempts ?? 1)) {
        await this.processingService.markFailed(
          videoId,
          VideoFailureReason.PROCESSING_ERROR,
        );
      }
      throw error;
    }
  }

  @OnWorkerEvent('ready')
  onReady(): void {
    this.logger.log(`Consuming "${VIDEO_PROCESSING_QUEUE}"`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessVideoJobData> | undefined, error: Error): void {
    this.logger.warn(
      `process-video ${job?.data.videoId ?? '?'} attempt ${job?.attemptsStarted ?? '?'} failed: ${error.message}`,
    );
  }
}

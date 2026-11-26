import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_MAINTENANCE_QUEUE = 'video-maintenance';
export const PROCESS_VIDEO_JOB = 'process-video';

/** Job Scheduler of the maintenance sweep (declared only by the worker). */
export const VIDEO_MAINTENANCE_SCHEDULER_ID = 'video-maintenance-sweep';
export const VIDEO_MAINTENANCE_SWEEP_JOB = 'sweep';

export const QUEUE_NAMES = [
  VIDEO_PROCESSING_QUEUE,
  VIDEO_MAINTENANCE_QUEUE,
] as const;

export interface ProcessVideoJobData {
  videoId: string;
}

/**
 * `jobId = videoId` makes the enqueue idempotent: adding a job whose id is
 * still in the queue (waiting/active/delayed/failed) is a no-op.
 */
export function processVideoJobOptions(videoId: string): JobsOptions {
  return {
    jobId: videoId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
  };
}

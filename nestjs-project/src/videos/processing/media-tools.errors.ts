/**
 * The input is not a usable video (cannot be parsed, or has no video stream).
 * Permanent: the job fails with `INVALID_MEDIA` and is never retried.
 */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

/**
 * ffprobe/ffmpeg failed for a reason that may not repeat (timeout, network,
 * any other non-zero exit). Retried by the queue's backoff policy.
 */
export class MediaToolTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaToolTransientError';
  }
}

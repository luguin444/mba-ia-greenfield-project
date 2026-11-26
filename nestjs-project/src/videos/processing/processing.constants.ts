/**
 * Upper bound for one ffprobe/ffmpeg run. A hung tool is killed (SIGTERM) and
 * the failure is transient, so it cannot hold a worker slot forever.
 */
export const MEDIA_TOOL_TIMEOUT_MS = 120000;

/**
 * stderr markers of an input the tools cannot parse at all. A non-zero exit
 * with one of them is a permanent failure (`INVALID_MEDIA`), never retried.
 */
export const INVALID_MEDIA_STDERR_MARKERS = [
  'Invalid data found when processing input',
  'moov atom not found',
] as const;

/** The thumbnail frame is taken at 10% of the duration, at most this far in. */
export const THUMBNAIL_MAX_OFFSET_SECONDS = 10;

/** Below this duration (or when it is unknown) the thumbnail is the first frame. */
export const THUMBNAIL_MIN_DURATION_SECONDS = 1;

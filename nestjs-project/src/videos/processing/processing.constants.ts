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

/**
 * TTL of the internal presigned GET handed to ffprobe/ffmpeg. It must outlive
 * the whole job attempt (two tool runs of up to 120 s each); every attempt
 * signs a fresh one.
 */
export const SOURCE_URL_TTL_SECONDS = 3600;

/** Thumbnail object name under `{videoId}/` in the thumbnails bucket. */
export const THUMBNAIL_OBJECT_NAME = 'default.jpg';

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/** Prefix of the local frame file in `os.tmpdir()`, removed after every job. */
export const THUMBNAIL_TMP_PREFIX = 'streamtube-thumbnail-';

/** Most rows one sweep tick handles per category (stale uploads, orphans). */
export const SWEEP_BATCH_SIZE = 100;

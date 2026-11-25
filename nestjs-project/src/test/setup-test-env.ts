/**
 * Jest setup file, loaded right after `dotenv/config` in both Jest configs.
 *
 * Jest reads the same `.env` as the containers. Without this override, the test
 * process and the running `video-worker` container would share the `bull` queue
 * prefix and the production buckets, so each could consume the other's jobs.
 * These values are force-assigned before any Nest module is compiled, so the
 * real `registerAs` + Joi path runs unchanged with test-scoped values.
 */
export const TEST_ENV_OVERRIDES = {
  QUEUE_PREFIX: 'test',
  S3_VIDEOS_BUCKET: 'videos-test',
  S3_THUMBNAILS_BUCKET: 'thumbnails-test',
  VIDEO_MAX_UPLOAD_BYTES: '12582912',
  VIDEO_UPLOAD_PART_SIZE_BYTES: '5242880',
} as const;

Object.assign(process.env, TEST_ENV_OVERRIDES);

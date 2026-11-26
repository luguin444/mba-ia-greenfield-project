import { registerAs } from '@nestjs/config';

const toInt = (value: string | undefined, fallback: number): number =>
  value === undefined ? fallback : parseInt(value, 10);

export default registerAs('video', () => ({
  maxUploadBytes: toInt(process.env.VIDEO_MAX_UPLOAD_BYTES, 10737418240),
  uploadPartSizeBytes: toInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES,
    67108864,
  ),
  uploadPartUrlTtlSeconds: toInt(
    process.env.VIDEO_UPLOAD_PART_URL_TTL_SECONDS,
    3600,
  ),
  playbackUrlTtlSeconds: toInt(
    process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS,
    14400,
  ),
  maxActiveUploadsPerChannel: toInt(
    process.env.VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL,
    5,
  ),
  sweepIntervalMs: toInt(process.env.VIDEO_SWEEP_INTERVAL_MS, 900000),
  uploadStaleAfterMs: toInt(process.env.VIDEO_UPLOAD_STALE_AFTER_MS, 86400000),
}));

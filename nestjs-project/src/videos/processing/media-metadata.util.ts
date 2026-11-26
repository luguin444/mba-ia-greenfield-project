import { InvalidMediaError } from './media-tools.errors';
import {
  THUMBNAIL_MAX_OFFSET_SECONDS,
  THUMBNAIL_MIN_DURATION_SECONDS,
} from './processing.constants';

/** The subset of `ffprobe -print_format json -show_format -show_streams` we read. */
export interface FfprobeOutput {
  format?: {
    duration?: string;
    format_name?: string;
  };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }[];
}

/** What the worker stores on the `videos` row after probing the source. */
export interface MediaMetadata {
  durationSeconds: number | null;
  formatName: string | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

/**
 * Maps ffprobe output to the stored metadata: container duration and format,
 * the first video stream's size and codec, and the first audio stream's codec.
 *
 * @throws InvalidMediaError when there is no video stream.
 */
export function mapProbeOutput(output: FfprobeOutput): MediaMetadata {
  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video) {
    throw new InvalidMediaError('The input has no video stream');
  }
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number.parseFloat(output.format?.duration ?? '');

  return {
    durationSeconds: Number.isFinite(duration) ? duration : null,
    formatName: output.format?.format_name ?? null,
    width: video.width ?? null,
    height: video.height ?? null,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

/**
 * Where the thumbnail frame is taken: 10% into the video, capped at 10 s, so it
 * skips intro black frames without seeking far into long files. Unknown or
 * sub-second durations use the first frame.
 */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (
    durationSeconds === null ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < THUMBNAIL_MIN_DURATION_SECONDS
  ) {
    return 0;
  }
  return Math.min(durationSeconds * 0.1, THUMBNAIL_MAX_OFFSET_SECONDS);
}

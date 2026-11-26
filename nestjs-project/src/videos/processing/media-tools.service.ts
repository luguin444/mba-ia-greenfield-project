import { execFile, type ExecFileException } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import {
  mapProbeOutput,
  type FfprobeOutput,
  type MediaMetadata,
} from './media-metadata.util';
import {
  InvalidMediaError,
  MediaToolTransientError,
} from './media-tools.errors';
import {
  INVALID_MEDIA_STDERR_MARKERS,
  MEDIA_TOOL_TIMEOUT_MS,
} from './processing.constants';

/**
 * Typed wrapper over the `ffprobe`/`ffmpeg` binaries. Uses `execFile` (no
 * shell), so the input URL and paths are plain arguments, never shell text.
 * Every failure is classified as `InvalidMediaError` (permanent) or
 * `MediaToolTransientError` (retryable).
 */
@Injectable()
export class MediaToolsService {
  /** Reads container and stream metadata. `input` may be a presigned URL. */
  async probe(input: string): Promise<MediaMetadata> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      input,
    ]);
    return mapProbeOutput(JSON.parse(stdout) as FfprobeOutput);
  }

  /** Writes the frame at `atSeconds` to `outPath` (format from its extension). */
  async extractFrame(
    input: string,
    atSeconds: number,
    outPath: string,
  ): Promise<void> {
    await this.run('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-ss',
      String(atSeconds),
      '-i',
      input,
      '-frames:v',
      '1',
      outPath,
    ]);
  }

  private run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { timeout: MEDIA_TOOL_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (error) {
            reject(classifyFailure(command, error, String(stderr)));
            return;
          }
          resolve(String(stdout));
        },
      );
    });
  }
}

function classifyFailure(
  command: string,
  error: ExecFileException,
  stderr: string,
): Error {
  if (error.killed) {
    return new MediaToolTransientError(
      `${command} was killed (${error.signal ?? 'no signal'}) after the ${MEDIA_TOOL_TIMEOUT_MS} ms timeout`,
    );
  }
  const detail = redactUrlQueries(stderr.trim() || error.message);
  if (INVALID_MEDIA_STDERR_MARKERS.some((marker) => stderr.includes(marker))) {
    return new InvalidMediaError(`${command} cannot read the input: ${detail}`);
  }
  return new MediaToolTransientError(
    `${command} failed (exit ${String(error.code)}): ${detail}`,
  );
}

/**
 * The input is a presigned URL, and ffprobe/ffmpeg echo it in stderr (as does
 * `execFile` in `error.message`). Its query string carries the signature, and
 * these messages reach the worker log and the job's `failedReason` in Redis.
 */
function redactUrlQueries(text: string): string {
  return text.replace(
    /(https?:\/\/[^\s?]+)\?\S*?(?=:\s|\s|$)/g,
    '$1?<redacted>',
  );
}

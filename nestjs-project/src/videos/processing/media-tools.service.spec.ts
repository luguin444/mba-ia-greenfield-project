import { execFile, type ExecFileException } from 'node:child_process';
import { Test } from '@nestjs/testing';
import {
  InvalidMediaError,
  MediaToolTransientError,
} from './media-tools.errors';
import { MediaToolsService } from './media-tools.service';
import { MEDIA_TOOL_TIMEOUT_MS } from './processing.constants';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

const execFileMock = execFile as unknown as jest.Mock;

/** Makes the next `execFile` call finish with this outcome. */
function nextRun(
  error: Partial<ExecFileException> | null,
  stdout = '',
  stderr = '',
): void {
  execFileMock.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: object, cb: ExecFileCallback) => {
      cb(
        error ? Object.assign(new Error('Command failed'), error) : null,
        stdout,
        stderr,
      );
    },
  );
}

const TIMED_OUT: Partial<ExecFileException> = {
  killed: true,
  signal: 'SIGTERM',
  code: null as unknown as number,
};

describe('MediaToolsService', () => {
  let service: MediaToolsService;

  beforeEach(async () => {
    execFileMock.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [MediaToolsService],
    }).compile();
    service = moduleRef.get(MediaToolsService);
  });

  describe('probe', () => {
    it('should run ffprobe without a shell, with the timeout, and map its JSON', async () => {
      nextRun(
        null,
        JSON.stringify({
          format: { duration: '2.000000', format_name: 'mov,mp4' },
          streams: [
            { codec_type: 'video', codec_name: 'h264', width: 160, height: 90 },
          ],
        }),
      );

      const metadata = await service.probe('http://minio:9000/v/x/source?s=1');

      expect(metadata).toEqual({
        durationSeconds: 2,
        formatName: 'mov,mp4',
        width: 160,
        height: 90,
        videoCodec: 'h264',
        audioCodec: null,
      });
      expect(execFileMock).toHaveBeenCalledWith(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          'http://minio:9000/v/x/source?s=1',
        ],
        { timeout: MEDIA_TOOL_TIMEOUT_MS },
        expect.any(Function),
      );
    });

    it('should classify a process killed by the timeout as transient', async () => {
      nextRun(TIMED_OUT);

      await expect(service.probe('in')).rejects.toBeInstanceOf(
        MediaToolTransientError,
      );
    });

    it('should classify a non-zero exit with "moov atom not found" as invalid media', async () => {
      nextRun(
        { code: 1 },
        '',
        '[mov,mp4 @ 0x1] moov atom not found\nin: Invalid data found when processing input',
      );

      await expect(service.probe('in')).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should classify any other non-zero exit as transient', async () => {
      nextRun(
        { code: 1 },
        '',
        'http://minio:9000/x: Server returned 5XX Server Error reply',
      );

      await expect(service.probe('in')).rejects.toBeInstanceOf(
        MediaToolTransientError,
      );
    });

    it('should redact the presigned URL query string from invalid-media errors', async () => {
      const signedUrl =
        'http://minio:9000/videos/abc/source?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef&x-id=GetObject';
      nextRun(
        { code: 1 },
        '',
        `${signedUrl}: Invalid data found when processing input`,
      );

      const error = await service.probe(signedUrl).catch((e: Error) => e);

      expect(error).toBeInstanceOf(InvalidMediaError);
      expect((error as Error).message).toBe(
        'ffprobe cannot read the input: http://minio:9000/videos/abc/source?<redacted>: Invalid data found when processing input',
      );
    });

    it('should redact the presigned URL query string when only error.message names the input', async () => {
      const signedUrl =
        'http://minio:9000/videos/abc/source?X-Amz-Signature=deadbeef';
      nextRun({ code: 1, message: `Command failed: ffprobe -i ${signedUrl}` });

      const error = await service.probe(signedUrl).catch((e: Error) => e);

      expect(error).toBeInstanceOf(MediaToolTransientError);
      expect((error as Error).message).not.toContain('X-Amz-Signature');
      expect((error as Error).message).toContain(
        'http://minio:9000/videos/abc/source?<redacted>',
      );
    });
  });

  describe('extractFrame', () => {
    it('should run ffmpeg for one frame at the offset, with the same timeout', async () => {
      nextRun(null);

      await service.extractFrame('in-url', 0.2, '/tmp/frame.jpg');

      expect(execFileMock).toHaveBeenCalledWith(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-y',
          '-ss',
          '0.2',
          '-i',
          'in-url',
          '-frames:v',
          '1',
          '/tmp/frame.jpg',
        ],
        { timeout: MEDIA_TOOL_TIMEOUT_MS },
        expect.any(Function),
      );
    });

    it('should classify a process killed by the timeout as transient', async () => {
      nextRun(TIMED_OUT);

      await expect(
        service.extractFrame('in', 0, '/tmp/frame.jpg'),
      ).rejects.toBeInstanceOf(MediaToolTransientError);
    });

    it('should classify "Invalid data found when processing input" as invalid media', async () => {
      nextRun({ code: 1 }, '', 'in: Invalid data found when processing input');

      await expect(
        service.extractFrame('in', 0, '/tmp/frame.jpg'),
      ).rejects.toBeInstanceOf(InvalidMediaError);
    });
  });
});

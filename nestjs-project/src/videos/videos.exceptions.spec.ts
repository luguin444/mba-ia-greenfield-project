import type { ArgumentsHost } from '@nestjs/common';
import type { DomainException } from '../common/exceptions/domain.exception';
import { DomainExceptionFilter } from '../common/filters/domain-exception.filter';
import {
  ActiveUploadLimitReachedException,
  ChannelNotFoundException,
  InvalidPartNumberException,
  InvalidVideoStateException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from './videos.exceptions';

function render(exception: DomainException): {
  status: number;
  body: unknown;
} {
  const json = jest.fn<void, [unknown]>();
  const status = jest.fn<{ json: typeof json }, [number]>(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;

  new DomainExceptionFilter().catch(exception, host);

  return {
    status: status.mock.calls[0][0],
    body: json.mock.calls[0][0],
  };
}

describe('videos exceptions (Error Catalog)', () => {
  it.each([
    [
      new VideoTooLargeException(),
      413,
      'VIDEO_TOO_LARGE',
      'Video exceeds the maximum upload size',
    ],
    [
      new ActiveUploadLimitReachedException(),
      409,
      'ACTIVE_UPLOAD_LIMIT_REACHED',
      'Too many uploads in progress for this channel',
    ],
    [
      new ChannelNotFoundException(),
      404,
      'CHANNEL_NOT_FOUND',
      'Channel not found for the authenticated user',
    ],
    [new VideoNotFoundException(), 404, 'VIDEO_NOT_FOUND', 'Video not found'],
    [
      new InvalidVideoStateException(),
      409,
      'INVALID_VIDEO_STATE',
      'Operation not allowed in the current video state',
    ],
    [
      new InvalidPartNumberException(),
      400,
      'INVALID_PART_NUMBER',
      'Part number out of range',
    ],
    [
      new UploadIncompleteException([2, 5]),
      409,
      'UPLOAD_INCOMPLETE',
      'Upload is missing parts: 2, 5',
    ],
    [
      new UploadSizeMismatchException(),
      422,
      'UPLOAD_SIZE_MISMATCH',
      'Uploaded size does not match the declared size',
    ],
    [
      new VideoNotReadyException(),
      409,
      'VIDEO_NOT_READY',
      'Video is not ready for playback',
    ],
  ])(
    'should render %p as the error envelope',
    (exception, statusCode, error, message) => {
      const rendered = render(exception);

      expect(rendered.status).toBe(statusCode);
      expect(rendered.body).toEqual({ statusCode, error, message });
    },
  );

  it('should list only the first 20 missing parts followed by an ellipsis', () => {
    const missing = Array.from({ length: 25 }, (_, i) => i + 1);

    const exception = new UploadIncompleteException(missing);

    expect(exception.message).toBe(
      `Upload is missing parts: ${missing.slice(0, 20).join(', ')}, …`,
    );
  });

  it('should not append an ellipsis when exactly 20 parts are missing', () => {
    const missing = Array.from({ length: 20 }, (_, i) => i + 1);

    expect(new UploadIncompleteException(missing).message).toBe(
      `Upload is missing parts: ${missing.join(', ')}`,
    );
  });
});

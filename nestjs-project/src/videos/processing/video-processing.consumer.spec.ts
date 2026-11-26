import { Test } from '@nestjs/testing';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ProcessVideoJobData } from '../../queue/queue.constants';
import { VideoFailureReason } from '../entities/video.entity';
import {
  InvalidMediaError,
  MediaToolTransientError,
} from './media-tools.errors';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { SourceObjectMissingError } from './video-processing.errors';
import { VideoProcessingService } from './video-processing.service';

const VIDEO_ID = '4f5d0c1e-4a4e-4c1c-9a57-2a4f3b0f6d11';

function jobOnAttempt(
  attemptsStarted: number,
  attempts = 3,
): Job<ProcessVideoJobData> {
  return {
    data: { videoId: VIDEO_ID },
    attemptsStarted,
    opts: { attempts },
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessingConsumer', () => {
  let consumer: VideoProcessingConsumer;
  const processingService = {
    process: jest.fn<Promise<void>, [string]>(),
    markFailed: jest.fn<Promise<boolean>, [string, VideoFailureReason]>(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    processingService.markFailed.mockResolvedValue(true);
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingConsumer,
        { provide: VideoProcessingService, useValue: processingService },
      ],
    }).compile();
    consumer = moduleRef.get(VideoProcessingConsumer);
  });

  it('should process the video of the job and mark nothing on success', async () => {
    processingService.process.mockResolvedValue();

    await consumer.process(jobOnAttempt(1));

    expect(processingService.process).toHaveBeenCalledWith(VIDEO_ID);
    expect(processingService.markFailed).not.toHaveBeenCalled();
  });

  it('should fail the video with INVALID_MEDIA and stop retrying on invalid media', async () => {
    processingService.process.mockRejectedValue(
      new InvalidMediaError('no video stream'),
    );

    await expect(consumer.process(jobOnAttempt(1))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(processingService.markFailed).toHaveBeenCalledWith(
      VIDEO_ID,
      VideoFailureReason.INVALID_MEDIA,
    );
  });

  it('should fail the video with PROCESSING_ERROR and stop retrying when the source is missing', async () => {
    processingService.process.mockRejectedValue(
      new SourceObjectMissingError(`${VIDEO_ID}/source`),
    );

    await expect(consumer.process(jobOnAttempt(1))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(processingService.markFailed).toHaveBeenCalledWith(
      VIDEO_ID,
      VideoFailureReason.PROCESSING_ERROR,
    );
  });

  it('should only rethrow a transient error before the last attempt', async () => {
    const transient = new MediaToolTransientError('ffprobe timed out');
    processingService.process.mockRejectedValue(transient);

    await expect(consumer.process(jobOnAttempt(1))).rejects.toBe(transient);
    await expect(consumer.process(jobOnAttempt(2))).rejects.toBe(transient);
    expect(processingService.markFailed).not.toHaveBeenCalled();
  });

  it('should fail the video with PROCESSING_ERROR and rethrow a transient error on the last attempt', async () => {
    const transient = new Error('connect ECONNREFUSED minio:9000');
    processingService.process.mockRejectedValue(transient);

    await expect(consumer.process(jobOnAttempt(3))).rejects.toBe(transient);
    expect(processingService.markFailed).toHaveBeenCalledWith(
      VIDEO_ID,
      VideoFailureReason.PROCESSING_ERROR,
    );
  });

  it('should treat a job without attempts as single-attempt', async () => {
    const transient = new Error('boom');
    processingService.process.mockRejectedValue(transient);
    const job = {
      data: { videoId: VIDEO_ID },
      attemptsStarted: 1,
      opts: {},
    } as Job<ProcessVideoJobData>;

    await expect(consumer.process(job)).rejects.toBe(transient);
    expect(processingService.markFailed).toHaveBeenCalledWith(
      VIDEO_ID,
      VideoFailureReason.PROCESSING_ERROR,
    );
  });
});

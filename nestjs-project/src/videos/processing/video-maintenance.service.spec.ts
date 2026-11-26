import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import videoConfig from '../../config/video.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  processVideoJobOptions,
} from '../../queue/queue.constants';
import { StorageService } from '../../storage/storage.service';
import {
  Video,
  VideoFailureReason,
  VideoProcessingStatus,
} from '../entities/video.entity';
import { VideoMaintenanceService } from './video-maintenance.service';

function row(id: string, overrides: Partial<Video> = {}): Video {
  return {
    id,
    source_key: `${id}/source`,
    upload_id: `upload-${id}`,
    ...overrides,
  } as Video;
}

/** A BullMQ job stub in `state`. */
function jobIn(state: string): { getState: () => Promise<string> } {
  return { getState: () => Promise.resolve(state) };
}

describe('VideoMaintenanceService', () => {
  let service: VideoMaintenanceService;
  let errorLog: jest.SpyInstance;
  const videoRepository = { find: jest.fn(), update: jest.fn() };
  const storageService = { abortMultipartUpload: jest.fn() };
  const processingQueue = { getJob: jest.fn(), add: jest.fn() };

  afterEach(() => {
    errorLog.mockRestore();
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    videoRepository.update.mockResolvedValue({ affected: 1 });
    storageService.abortMultipartUpload.mockResolvedValue(undefined);
    processingQueue.add.mockResolvedValue({});
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoMaintenanceService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: processingQueue,
        },
        {
          provide: videoConfig.KEY,
          useValue: { sweepIntervalMs: 900000, uploadStaleAfterMs: 86400000 },
        },
      ],
    }).compile();
    service = moduleRef.get(VideoMaintenanceService);
  });

  describe('sweepOrphanedProcessing', () => {
    it('should re-enqueue process-video with the contract options when the job is missing', async () => {
      videoRepository.find.mockResolvedValue([row('v1')]);
      processingQueue.getJob.mockResolvedValue(undefined);

      const result = await service.sweepOrphanedProcessing();

      expect(processingQueue.add).toHaveBeenCalledWith(
        PROCESS_VIDEO_JOB,
        { videoId: 'v1' },
        processVideoJobOptions('v1'),
      );
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(result).toEqual({ requeued: 1, failed: 0, errors: 0 });
    });

    it('should fail the row with PROCESSING_ERROR, only while still processing, when the job failed', async () => {
      videoRepository.find.mockResolvedValue([row('v1')]);
      processingQueue.getJob.mockResolvedValue(jobIn('failed'));

      const result = await service.sweepOrphanedProcessing();

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'v1', processing_status: VideoProcessingStatus.PROCESSING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: VideoFailureReason.PROCESSING_ERROR,
        },
      );
      expect(processingQueue.add).not.toHaveBeenCalled();
      expect(result).toEqual({ requeued: 0, failed: 1, errors: 0 });
    });

    it.each(['waiting', 'active', 'delayed'])(
      'should leave the row alone when the job is %s',
      async (state) => {
        videoRepository.find.mockResolvedValue([row('v1')]);
        processingQueue.getJob.mockResolvedValue(jobIn(state));

        const result = await service.sweepOrphanedProcessing();

        expect(processingQueue.add).not.toHaveBeenCalled();
        expect(videoRepository.update).not.toHaveBeenCalled();
        expect(result).toEqual({ requeued: 0, failed: 0, errors: 0 });
      },
    );

    it('should keep going when one row fails', async () => {
      videoRepository.find.mockResolvedValue([row('v1'), row('v2')]);
      processingQueue.getJob
        .mockRejectedValueOnce(new Error('Redis connection lost'))
        .mockResolvedValueOnce(undefined);

      const result = await service.sweepOrphanedProcessing();

      expect(processingQueue.add).toHaveBeenCalledTimes(1);
      expect(processingQueue.add).toHaveBeenCalledWith(
        PROCESS_VIDEO_JOB,
        { videoId: 'v2' },
        processVideoJobOptions('v2'),
      );
      expect(result).toEqual({ requeued: 1, failed: 0, errors: 1 });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('video v1: Redis connection lost'),
        expect.any(String),
      );
    });
  });

  describe('sweepStaleUploads', () => {
    it('should claim the row and abort its multipart with the previous upload id', async () => {
      videoRepository.find.mockResolvedValue([row('v1')]);

      const result = await service.sweepStaleUploads();

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'v1', processing_status: VideoProcessingStatus.UPLOADING },
        {
          processing_status: VideoProcessingStatus.FAILED,
          failure_reason: VideoFailureReason.UPLOAD_ABANDONED,
          upload_id: null,
        },
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'v1/source',
        'upload-v1',
      );
      expect(result).toEqual({ abandoned: 1, errors: 0 });
    });

    it('should not abort the multipart when the claim was lost', async () => {
      videoRepository.find.mockResolvedValue([row('v1')]);
      videoRepository.update.mockResolvedValue({ affected: 0 });

      const result = await service.sweepStaleUploads();

      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(result).toEqual({ abandoned: 0, errors: 0 });
    });

    it('should keep going when aborting one multipart fails', async () => {
      videoRepository.find.mockResolvedValue([row('v1'), row('v2')]);
      storageService.abortMultipartUpload.mockRejectedValueOnce(
        new Error('storage unavailable'),
      );

      const result = await service.sweepStaleUploads();

      expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ abandoned: 1, errors: 1 });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('video v1: storage unavailable'),
        expect.any(String),
      );
    });
  });
});

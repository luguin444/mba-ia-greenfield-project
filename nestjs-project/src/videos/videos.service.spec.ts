import { Test } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import * as publicIdUtil from './public-id.util';
import {
  ActiveUploadLimitReachedException,
  ChannelNotFoundException,
  VideoTooLargeException,
} from './videos.exceptions';
import { VideosService } from './videos.service';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const UPLOAD_ID = 'upload-1';

const DEFAULT_CONFIG = {
  maxUploadBytes: 10 * GIB,
  uploadPartSizeBytes: 64 * MIB,
  uploadPartUrlTtlSeconds: 3600,
  playbackUrlTtlSeconds: 14400,
  maxActiveUploadsPerChannel: 5,
  sweepIntervalMs: 900000,
  uploadStaleAfterMs: 86400000,
};

function pgUniqueViolation(column: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT INTO "videos" ...',
    [],
    Object.assign(new Error('duplicate key value'), {
      code: '23505',
      detail: `Key (${column})=(abc) already exists.`,
    }),
  );
}

function initiateDto(
  overrides: Partial<InitiateUploadDto> = {},
): InitiateUploadDto {
  return {
    fileName: 'aula.mp4',
    sizeBytes: 100 * MIB,
    mimeType: 'video/mp4',
    ...overrides,
  };
}

describe('VideosService', () => {
  let service: VideosService;
  let channelsService: {
    findIdByUserId: jest.Mock;
    lockIdByUserId: jest.Mock;
  };
  let storageService: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
  };
  let manager: {
    count: jest.Mock;
    query: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  async function buildService(
    config: Partial<typeof DEFAULT_CONFIG> = {},
  ): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: DataSource, useValue: dataSource },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        {
          provide: videoConfig.KEY,
          useValue: { ...DEFAULT_CONFIG, ...config },
        },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  }

  beforeEach(async () => {
    channelsService = {
      findIdByUserId: jest.fn().mockResolvedValue(CHANNEL_ID),
      lockIdByUserId: jest.fn().mockResolvedValue(CHANNEL_ID),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue(UPLOAD_ID),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignUploadPart: jest.fn(
        (key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`http://storage/${key}?partNumber=${partNumber}`),
      ),
    };
    manager = {
      count: jest.fn().mockResolvedValue(0),
      query: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((_entity: unknown, fields: Partial<Video>) => fields),
      save: jest.fn((video: Partial<Video>) => Promise.resolve(video)),
    };
    dataSource = {
      transaction: jest.fn((callback: (m: typeof manager) => unknown) =>
        callback(manager),
      ),
    };
    await buildService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('initiateUpload', () => {
    it('should use 64 MiB parts and 160 parts for 10 GiB with the defaults, signing only the first 100', async () => {
      const result = await service.initiateUpload(
        USER_ID,
        initiateDto({ sizeBytes: 10737418240 }),
      );

      expect(result.partSize).toBe(67108864);
      expect(result.partCount).toBe(160);
      expect(result.parts).toHaveLength(100);
      expect(result.parts.map((part) => part.partNumber)).toEqual(
        Array.from({ length: 100 }, (_, index) => index + 1),
      );
    });

    it('should grow partSize to ceil(size / 10000) when the configured size would exceed 10,000 parts', async () => {
      await buildService({
        maxUploadBytes: 100 * GIB,
        uploadPartSizeBytes: 5 * MIB,
      });

      const result = await service.initiateUpload(
        USER_ID,
        initiateDto({ sizeBytes: 60_000_000_000 }),
      );

      expect(result.partSize).toBe(6_000_000);
      expect(result.partCount).toBe(10000);
    });

    it('should round the part count up and sign every part when there are fewer than 100', async () => {
      await buildService({ uploadPartSizeBytes: 5 * MIB });

      const result = await service.initiateUpload(
        USER_ID,
        initiateDto({ sizeBytes: 11 * MIB }),
      );

      expect(result.partSize).toBe(5 * MIB);
      expect(result.partCount).toBe(3);
      expect(result.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    });

    it('should open the multipart upload on {id}/source with the declared mime type and persist an uploading row', async () => {
      const result = await service.initiateUpload(USER_ID, initiateDto());

      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        `${result.videoId}/source`,
        'video/mp4',
      );
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.videoId,
          channel_id: CHANNEL_ID,
          processing_status: VideoProcessingStatus.UPLOADING,
          upload_id: UPLOAD_ID,
          upload_part_size_bytes: 64 * MIB,
          source_key: `${result.videoId}/source`,
          original_filename: 'aula.mp4',
        }),
      );
      expect(result.uploadId).toBe(UPLOAD_ID);
    });

    it.each([
      ['aula.mp4', 'aula'],
      ['aula-01.final.mov', 'aula-01.final'],
      ['.mp4', '.mp4'],
      ['sem-extensao', 'sem-extensao'],
    ])(
      'should default the title of %p to %p',
      async (fileName, expectedTitle) => {
        await service.initiateUpload(USER_ID, initiateDto({ fileName }));

        expect(manager.save).toHaveBeenCalledWith(
          expect.objectContaining({ title: expectedTitle }),
        );
      },
    );

    it('should keep the informed title', async () => {
      await service.initiateUpload(
        USER_ID,
        initiateDto({ title: 'Minha aula' }),
      );

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Minha aula' }),
      );
    });

    it('should reject VIDEO_TOO_LARGE without touching storage or opening a transaction', async () => {
      await expect(
        service.initiateUpload(
          USER_ID,
          initiateDto({ sizeBytes: DEFAULT_CONFIG.maxUploadBytes + 1 }),
        ),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should reject CHANNEL_NOT_FOUND when the user has no channel', async () => {
      channelsService.findIdByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload(USER_ID, initiateDto()),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject ACTIVE_UPLOAD_LIMIT_REACHED before opening a multipart upload', async () => {
      manager.count.mockResolvedValue(
        DEFAULT_CONFIG.maxActiveUploadsPerChannel,
      );

      await expect(
        service.initiateUpload(USER_ID, initiateDto()),
      ).rejects.toBeInstanceOf(ActiveUploadLimitReachedException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should abort the multipart upload best-effort and rethrow when the insert fails', async () => {
      const insertError = new Error('insert failed');
      manager.save.mockRejectedValue(insertError);

      await expect(service.initiateUpload(USER_ID, initiateDto())).rejects.toBe(
        insertError,
      );

      const [key] = storageService.createMultipartUpload.mock.calls[0] as [
        string,
      ];
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        key,
        UPLOAD_ID,
      );
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should still rethrow the insert error when the compensating abort also fails', async () => {
      const insertError = new Error('insert failed');
      manager.save.mockRejectedValue(insertError);
      storageService.abortMultipartUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(service.initiateUpload(USER_ID, initiateDto())).rejects.toBe(
        insertError,
      );
    });

    it('should retry with a new public_id inside a fresh SAVEPOINT on a public_id unique violation', async () => {
      const generate = jest
        .spyOn(publicIdUtil, 'generatePublicId')
        .mockReturnValueOnce('collidingId')
        .mockReturnValueOnce('freshIdABCD');
      manager.save.mockRejectedValueOnce(pgUniqueViolation('public_id'));

      const result = await service.initiateUpload(USER_ID, initiateDto());

      expect(result.publicId).toBe('freshIdABCD');
      expect(generate).toHaveBeenCalledTimes(2);
      expect(manager.query.mock.calls.map(([sql]) => sql as string)).toEqual([
        'SAVEPOINT video_public_id_1',
        'ROLLBACK TO SAVEPOINT video_public_id_1',
        'SAVEPOINT video_public_id_2',
        'RELEASE SAVEPOINT video_public_id_2',
      ]);
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should not retry a unique violation on another column', async () => {
      const otherViolation = pgUniqueViolation('id');
      manager.save.mockRejectedValueOnce(otherViolation);

      await expect(service.initiateUpload(USER_ID, initiateDto())).rejects.toBe(
        otherViolation,
      );
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(storageService.abortMultipartUpload).toHaveBeenCalled();
    });

    it('should give up after 5 public_id collisions and abort the multipart upload', async () => {
      manager.save.mockRejectedValue(pgUniqueViolation('public_id'));

      await expect(
        service.initiateUpload(USER_ID, initiateDto()),
      ).rejects.toBeInstanceOf(QueryFailedError);
      expect(manager.save).toHaveBeenCalledTimes(5);
      expect(storageService.abortMultipartUpload).toHaveBeenCalled();
    });
  });
});

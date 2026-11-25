import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import type { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { PartUrlDto } from './dto/part-url.dto';
import type { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import type { PartUrlsDto } from './dto/part-urls.dto';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  MAX_PUBLIC_ID_ATTEMPTS,
  MAX_SIGNED_PARTS_PER_BATCH,
  MAX_UPLOAD_PARTS,
} from './videos.constants';
import {
  ActiveUploadLimitReachedException,
  ChannelNotFoundException,
  InvalidPartNumberException,
  InvalidVideoStateException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './videos.exceptions';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';

interface UploadLayout {
  partSize: number;
  partCount: number;
}

/** A video whose multipart upload is still open. */
type UploadingVideo = Video & { upload_id: string };

type NewVideoFields = Omit<
  Partial<Video>,
  'public_id' | 'created_at' | 'updated_at'
>;

function isUniqueViolationOn(error: unknown, column: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  // QueryFailedError copies the pg driver fields (code, detail) onto itself.
  const { code, detail } = error as QueryFailedError & {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(`(${column})`)
  );
}

/** `aula.mp4` → `aula`; `.mp4` or a name left empty keeps the whole `fileName`. */
function defaultTitle(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot).trim() : '';
  return base || fileName;
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const channelId = await this.channelsService.findIdByUserId(userId);
    if (!channelId) throw new ChannelNotFoundException();
    if (dto.sizeBytes > this.config.maxUploadBytes) {
      throw new VideoTooLargeException();
    }

    const { partSize, partCount } = this.layoutFor(dto.sizeBytes);
    const video = await this.dataSource.transaction(async (manager) => {
      const lockedChannelId = await this.channelsService.lockIdByUserId(
        manager,
        userId,
      );
      if (!lockedChannelId) throw new ChannelNotFoundException();

      const activeUploads = await manager.count(Video, {
        where: {
          channel_id: lockedChannelId,
          processing_status: VideoProcessingStatus.UPLOADING,
        },
      });
      if (activeUploads >= this.config.maxActiveUploadsPerChannel) {
        throw new ActiveUploadLimitReachedException();
      }

      const id = randomUUID();
      const sourceKey = `${id}/source`;
      const uploadId = await this.storageService.createMultipartUpload(
        sourceKey,
        dto.mimeType,
      );
      try {
        return await this.insertWithUniquePublicId(manager, {
          id,
          title: dto.title ?? defaultTitle(dto.fileName),
          channel_id: lockedChannelId,
          processing_status: VideoProcessingStatus.UPLOADING,
          publication_status: VideoPublicationStatus.DRAFT,
          original_filename: dto.fileName,
          mime_type: dto.mimeType,
          size_bytes: dto.sizeBytes,
          upload_id: uploadId,
          upload_part_size_bytes: partSize,
          source_key: sourceKey,
        });
      } catch (error) {
        await this.abortUploadBestEffort(sourceKey, uploadId);
        throw error;
      }
    });

    const firstBatch = Array.from(
      { length: Math.min(partCount, MAX_SIGNED_PARTS_PER_BATCH) },
      (_, index) => index + 1,
    );
    const { parts, expiresAt } = await this.signParts(
      video as UploadingVideo,
      firstBatch,
    );
    return {
      videoId: video.id,
      publicId: video.public_id,
      uploadId: video.upload_id as string,
      partSize,
      partCount,
      parts,
      expiresAt,
    };
  }

  /**
   * Resume path: lists the parts already stored and signs the missing ones
   * (or exactly `dto.partNumbers`). Touches `updated_at`, the "last upload
   * activity" read by the maintenance sweep.
   */
  async signPartUrls(
    id: string,
    userId: string,
    dto: PartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    const video = await this.findOwnedOrFail(id, userId);
    this.assertUploading(video);
    const { partSize, partCount } = this.layoutOf(video);
    if (dto.partNumbers?.some((partNumber) => partNumber > partCount)) {
      throw new InvalidPartNumberException();
    }

    const stored = await this.storageService.listAllParts(
      video.source_key,
      video.upload_id,
    );
    const uploadedParts = stored
      .map((part) => ({
        partNumber: part.partNumber,
        size: part.size,
        etag: part.eTag,
      }))
      .sort((a, b) => a.partNumber - b.partNumber);
    const storedNumbers = new Set(stored.map((part) => part.partNumber));
    const toSign = dto.partNumbers
      ? [...dto.partNumbers].sort((a, b) => a - b)
      : this.missingPartNumbers(storedNumbers, partCount).slice(
          0,
          MAX_SIGNED_PARTS_PER_BATCH,
        );

    const { parts, expiresAt } = await this.signParts(video, toSign);
    await this.videoRepository.update(
      { id: video.id, processing_status: VideoProcessingStatus.UPLOADING },
      { updated_at: () => 'CURRENT_TIMESTAMP' },
    );
    return {
      videoId: video.id,
      uploadId: video.upload_id,
      partSize,
      partCount,
      uploadedParts,
      parts,
      expiresAt,
    };
  }

  /**
   * Hide, don't forbid: a missing video and a video of another channel are
   * the same `VIDEO_NOT_FOUND`, so the caller cannot probe for existence.
   */
  private async findOwnedOrFail(id: string, userId: string): Promise<Video> {
    const [video, channelId] = await Promise.all([
      this.videoRepository.findOne({ where: { id } }),
      this.channelsService.findIdByUserId(userId),
    ]);
    if (!video || video.channel_id !== channelId) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private assertUploading(video: Video): asserts video is UploadingVideo {
    if (
      video.processing_status !== VideoProcessingStatus.UPLOADING ||
      video.upload_id === null
    ) {
      throw new InvalidVideoStateException();
    }
  }

  private missingPartNumbers(
    storedNumbers: ReadonlySet<number>,
    partCount: number,
  ): number[] {
    const missing: number[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      if (!storedNumbers.has(partNumber)) missing.push(partNumber);
    }
    return missing;
  }

  /** `partSize = max(configured, ceil(size / 10000))`, frozen at initiate. */
  private layoutFor(sizeBytes: number): UploadLayout {
    const partSize = Math.max(
      this.config.uploadPartSizeBytes,
      Math.ceil(sizeBytes / MAX_UPLOAD_PARTS),
    );
    return { partSize, partCount: Math.ceil(sizeBytes / partSize) };
  }

  /** Layout frozen on the row at initiate (`partCount` is derived, not stored). */
  private layoutOf(video: Video): UploadLayout {
    const partSize = video.upload_part_size_bytes;
    return { partSize, partCount: Math.ceil(video.size_bytes / partSize) };
  }

  /**
   * Each attempt runs inside its own SAVEPOINT: the insert happens inside the
   * initiate transaction, and a failed statement would abort it otherwise.
   */
  private async insertWithUniquePublicId(
    manager: EntityManager,
    fields: NewVideoFields,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      const savepoint = `video_public_id_${attempt}`;
      await manager.query(`SAVEPOINT ${savepoint}`);
      try {
        const video = await manager.save(
          manager.create(Video, { ...fields, public_id: generatePublicId() }),
        );
        await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
        return video;
      } catch (error) {
        await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        if (
          !isUniqueViolationOn(error, PUBLIC_ID_COLUMN) ||
          attempt >= MAX_PUBLIC_ID_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  }

  /**
   * Compensation after a failed insert. The caller rethrows the original
   * error, so an abort failure is only logged: the insert error is the one
   * that explains the failed request.
   */
  private async abortUploadBestEffort(
    sourceKey: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(sourceKey, uploadId);
    } catch (abortError) {
      this.logger.warn(
        `Could not abort multipart upload ${uploadId} of ${sourceKey}`,
        abortError instanceof Error ? abortError.stack : String(abortError),
      );
    }
  }

  private async signParts(
    video: UploadingVideo,
    partNumbers: number[],
  ): Promise<{ parts: PartUrlDto[]; expiresAt: string }> {
    const ttlSeconds = this.config.uploadPartUrlTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          video.source_key,
          video.upload_id,
          partNumber,
          ttlSeconds,
        ),
      })),
    );
    return { parts, expiresAt };
  }
}

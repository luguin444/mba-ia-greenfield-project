import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import storageConfig from '../../config/storage.config';
import { StorageService } from '../../storage/storage.service';
import {
  Video,
  VideoFailureReason,
  VideoProcessingStatus,
} from '../entities/video.entity';
import { thumbnailTimestamp } from './media-metadata.util';
import { MediaToolsService } from './media-tools.service';
import {
  SOURCE_URL_TTL_SECONDS,
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_OBJECT_NAME,
  THUMBNAIL_TMP_PREFIX,
} from './processing.constants';
import { SourceObjectMissingError } from './video-processing.errors';

/**
 * States the worker may write. `processing` is the normal run and `ready` an
 * idempotent re-run. `uploading`/`failed` rows belong to the API or the sweep
 * and are never touched, so a late job cannot resurrect them.
 */
const WRITABLE_STATES = [
  VideoProcessingStatus.PROCESSING,
  VideoProcessingStatus.READY,
];

/**
 * The `process-video` job body: probes the uploaded source through an internal
 * presigned URL (ffprobe/ffmpeg read only what they need via HTTP Range),
 * stores a thumbnail and the metadata, and marks the video `ready`.
 *
 * Throws `InvalidMediaError` / `SourceObjectMissingError` for permanent
 * failures; any other error is transient. Deciding retry vs failure is the
 * consumer's job.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaTools: MediaToolsService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || !WRITABLE_STATES.includes(video.processing_status)) {
      this.logger.log(
        `Skipping video ${videoId}: ${video ? `status is ${video.processing_status}` : 'not found'}`,
      );
      return;
    }

    const head = await this.storageService.headObject(
      this.storage.videosBucket,
      video.source_key,
    );
    if (!head) throw new SourceObjectMissingError(video.source_key);

    const sourceUrl = await this.storageService.presignGetObject(
      video.source_key,
      SOURCE_URL_TTL_SECONDS,
      { client: 'internal' },
    );
    const metadata = await this.mediaTools.probe(sourceUrl);
    const thumbnailKey = `${video.id}/${THUMBNAIL_OBJECT_NAME}`;
    await this.storeThumbnail(
      sourceUrl,
      thumbnailTimestamp(metadata.durationSeconds),
      thumbnailKey,
    );

    const result = await this.videoRepository.update(
      { id: video.id, processing_status: In(WRITABLE_STATES) },
      {
        duration_seconds: metadata.durationSeconds,
        format_name: metadata.formatName,
        width: metadata.width,
        height: metadata.height,
        video_codec: metadata.videoCodec,
        audio_codec: metadata.audioCodec,
        thumbnail_key: thumbnailKey,
        processing_status: VideoProcessingStatus.READY,
        processed_at: () => 'CURRENT_TIMESTAMP',
        failure_reason: null,
      },
    );
    if (!result.affected) {
      this.logger.warn(
        `Video ${video.id} left processing while the job ran; result discarded`,
      );
    }
  }

  /**
   * Moves the video to `failed` with `reason`, only from a state the worker
   * owns. Returns whether the row changed.
   */
  async markFailed(
    videoId: string,
    reason: VideoFailureReason,
  ): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id: videoId, processing_status: In(WRITABLE_STATES) },
      {
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: reason,
      },
    );
    return Boolean(result.affected);
  }

  /** The local frame file is removed whether the extraction/upload succeeds or not. */
  private async storeThumbnail(
    sourceUrl: string,
    atSeconds: number,
    key: string,
  ): Promise<void> {
    const framePath = join(
      tmpdir(),
      `${THUMBNAIL_TMP_PREFIX}${randomUUID()}.jpg`,
    );
    try {
      await this.mediaTools.extractFrame(sourceUrl, atSeconds, framePath);
      await this.storageService.putObject(
        this.storage.thumbnailsBucket,
        key,
        await readFile(framePath),
        THUMBNAIL_CONTENT_TYPE,
      );
    } finally {
      await rm(framePath, { force: true });
    }
  }
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoProcessingStatus {
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export enum VideoPublicationStatus {
  DRAFT = 'draft',
}

export enum VideoFailureReason {
  UPLOAD_ABANDONED = 'UPLOAD_ABANDONED',
  UPLOAD_ABORTED = 'UPLOAD_ABORTED',
  UPLOAD_SIZE_MISMATCH = 'UPLOAD_SIZE_MISMATCH',
  INVALID_MEDIA = 'INVALID_MEDIA',
  PROCESSING_ERROR = 'PROCESSING_ERROR',
}

// pg returns bigint as string; sizes up to 10 GiB stay far below 2^53.
const bigintToNumber: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
@Index(['public_id'], { unique: true })
@Index(['channel_id', 'processing_status'])
@Index(['processing_status', 'updated_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 11 })
  public_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({
    type: 'enum',
    enum: VideoProcessingStatus,
    enumName: 'videos_processing_status_enum',
    default: VideoProcessingStatus.UPLOADING,
  })
  processing_status: VideoProcessingStatus;

  @Column({
    type: 'enum',
    enum: VideoPublicationStatus,
    enumName: 'videos_publication_status_enum',
    default: VideoPublicationStatus.DRAFT,
  })
  publication_status: VideoPublicationStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  failure_reason: VideoFailureReason | null;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 127 })
  mime_type: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  size_bytes: number;

  @Column({ type: 'text', nullable: true })
  upload_id: string | null;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  upload_part_size_bytes: number;

  @Column({ type: 'varchar', length: 255 })
  source_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  audio_codec: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  format_name: string | null;

  @Column({ type: 'timestamp', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}

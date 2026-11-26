import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';

/** A confirmed user with its channel, the owner every video row needs. */
export async function createChannel(
  dataSource: DataSource,
  label = 'worker',
): Promise<Channel> {
  const user = await dataSource.getRepository(User).save({
    email: `${label}-${randomUUID()}@example.com`,
    password: 'hashed-password',
    is_confirmed: true,
  });
  return dataSource.getRepository(Channel).save({
    name: label,
    nickname: `${label}-${randomUUID().slice(0, 8)}`,
    user_id: user.id,
  });
}

/**
 * Inserts a video row straight into the DB, in any state, for worker-side
 * suites (processing, maintenance) that start where the API left off.
 * `source_key` follows the API's `{id}/source` layout.
 */
export async function insertVideo(
  dataSource: DataSource,
  channelId: string,
  overrides: Partial<Video> = {},
): Promise<Video> {
  const id = overrides.id ?? randomUUID();
  return dataSource.getRepository(Video).save({
    id,
    public_id: generatePublicId(),
    title: 'clip',
    channel_id: channelId,
    processing_status: VideoProcessingStatus.PROCESSING,
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: 1024,
    upload_part_size_bytes: 5242880,
    source_key: `${id}/source`,
    ...overrides,
  });
}

/** Moves `updated_at` into the past (bypassing `@UpdateDateColumn`). */
export async function ageVideo(
  dataSource: DataSource,
  videoId: string,
  ageMs: number,
): Promise<void> {
  await dataSource.query(
    `UPDATE "videos" SET "updated_at" = now() - make_interval(secs => $2) WHERE "id" = $1`,
    [videoId, ageMs / 1000],
  );
}

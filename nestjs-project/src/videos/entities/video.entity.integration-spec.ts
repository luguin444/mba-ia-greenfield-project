import { randomUUID } from 'crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import {
  Video,
  VideoProcessingStatus,
  VideoPublicationStatus,
} from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const TEN_GIB = 10737418240;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'video_owner@example.com', password: 'hashed' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Owner', nickname: 'owner', user_id: user.id });
  });

  let publicIdCounter = 0;
  function requiredFields(overrides: Partial<Video> = {}): Partial<Video> {
    const id = randomUUID();
    return {
      id,
      public_id: `pid${String(++publicIdCounter).padStart(8, '0')}`,
      title: 'My video',
      channel_id: channel.id,
      original_filename: 'my-video.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1024,
      upload_part_size_bytes: 5242880,
      source_key: `${id}/source`,
      ...overrides,
    };
  }

  function pgCode(err: unknown): string | undefined {
    return err instanceof QueryFailedError
      ? (err.driverError as { code?: string }).code
      : undefined;
  }

  it('should default to uploading + draft and keep metadata columns null', async () => {
    const saved = await videoRepository.save(
      videoRepository.create(requiredFields()),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    expect(found.publication_status).toBe(VideoPublicationStatus.DRAFT);
    expect(found).toMatchObject({
      failure_reason: null,
      upload_id: null,
      thumbnail_key: null,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      audio_codec: null,
      format_name: null,
      processed_at: null,
    });
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('should keep the application-generated id', async () => {
    const fields = requiredFields();

    const saved = await videoRepository.save(videoRepository.create(fields));

    expect(saved.id).toBe(fields.id);
  });

  it('should reject a video without title (NOT NULL)', async () => {
    const error: unknown = await videoRepository
      .insert(requiredFields({ title: undefined }))
      .catch((err: unknown) => err);

    expect(pgCode(error)).toBe('23502');
  });

  it('should reject a duplicated public_id (23505)', async () => {
    await videoRepository.insert(requiredFields({ public_id: 'dupPublicId' }));

    const error: unknown = await videoRepository
      .insert(requiredFields({ public_id: 'dupPublicId' }))
      .catch((err: unknown) => err);

    expect(pgCode(error)).toBe('23505');
  });

  it('should reject an unknown channel_id (FK violation)', async () => {
    const error: unknown = await videoRepository
      .insert(requiredFields({ channel_id: randomUUID() }))
      .catch((err: unknown) => err);

    expect(pgCode(error)).toBe('23503');
  });

  it('should read bigint sizes back as numbers', async () => {
    const saved = await videoRepository.save(
      videoRepository.create(
        requiredFields({
          size_bytes: TEN_GIB,
          upload_part_size_bytes: TEN_GIB,
        }),
      ),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(TEN_GIB);
    expect(typeof found.size_bytes).toBe('number');
    expect(found.upload_part_size_bytes).toBe(TEN_GIB);
  });

  it('should load the owning channel through the many-to-one relation', async () => {
    const saved = await videoRepository.save(
      videoRepository.create(requiredFields()),
    );

    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });
    expect(found.channel.id).toBe(channel.id);
  });
});

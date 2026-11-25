import {
  DataSource,
  PessimisticLockTransactionRequiredError,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { ChannelsService } from './channels.service';
import { Channel } from './entities/channel.entity';
import { Video } from '../videos/entities/video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('ChannelsService (integration)', () => {
  let dataSource: DataSource;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    channelsService = new ChannelsService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUser(): Promise<User> {
    return userRepository.save(
      userRepository.create({
        email: `ch_svc_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
  }

  describe('createChannel', () => {
    it('persists a channel derived from email', async () => {
      const user = await createUser();

      const channel = await channelsService.createChannel(
        user.id,
        'mynick@example.com',
      );

      expect(channel.id).toBeDefined();
      expect(channel.nickname).toBe('mynick');
      expect(channel.name).toBe('mynick');
      expect(channel.user_id).toBe(user.id);

      const persisted = await channelRepository.findOneBy({ user_id: user.id });
      expect(persisted).not.toBeNull();
      expect(persisted!.nickname).toBe('mynick');
    });

    it('derives nickname from email prefix', async () => {
      const user = await createUser();

      const channel = await channelsService.createChannel(
        user.id,
        'John.Doe+tag@example.com',
      );

      expect(channel.nickname).toBe('johndoetag');
    });

    it('resolves nickname collision by appending a suffix', async () => {
      const user1 = await createUser();
      const user2 = await createUser();

      await channelsService.createChannel(user1.id, 'shared@example.com');
      const channel2 = await channelsService.createChannel(
        user2.id,
        'shared@example.com',
      );

      expect(channel2.nickname).toMatch(/^shared_[a-z0-9]{3}$/);

      const channels = await channelRepository.find();
      expect(channels).toHaveLength(2);
    });
  });

  describe('findIdByUserId', () => {
    it("returns the id of the user's channel", async () => {
      const user = await createUser();
      const channel = await channelsService.createChannel(user.id, user.email);

      await expect(channelsService.findIdByUserId(user.id)).resolves.toBe(
        channel.id,
      );
    });

    it('returns null for a user without a channel', async () => {
      const user = await createUser();

      await expect(channelsService.findIdByUserId(user.id)).resolves.toBeNull();
    });
  });

  describe('lockIdByUserId', () => {
    it("returns the channel id and holds a row lock until the caller's transaction ends", async () => {
      const user = await createUser();
      const channel = await channelsService.createChannel(user.id, user.email);
      let competingError: unknown;

      await dataSource.transaction(async (manager) => {
        await expect(
          channelsService.lockIdByUserId(manager, user.id),
        ).resolves.toBe(channel.id);

        // A second connection cannot take the same row lock meanwhile.
        competingError = await dataSource
          .query('SELECT id FROM "channels" WHERE id = $1 FOR UPDATE NOWAIT', [
            channel.id,
          ])
          .catch((err: unknown) => err);
      });

      expect(competingError).toBeInstanceOf(QueryFailedError);
      expect(
        (competingError as QueryFailedError & { code?: string }).code,
      ).toBe('55P03');
      await expect(
        dataSource.query(
          'SELECT id FROM "channels" WHERE id = $1 FOR UPDATE NOWAIT',
          [channel.id],
        ),
      ).resolves.toHaveLength(1);
    });

    it('returns null for a user without a channel', async () => {
      const user = await createUser();

      await dataSource.transaction(async (manager) => {
        await expect(
          channelsService.lockIdByUserId(manager, user.id),
        ).resolves.toBeNull();
      });
    });

    it('refuses to run outside a transaction', async () => {
      const user = await createUser();

      await expect(
        channelsService.lockIdByUserId(dataSource.manager, user.id),
      ).rejects.toBeInstanceOf(PessimisticLockTransactionRequiredError);
    });
  });
});

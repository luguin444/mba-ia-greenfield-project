import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { appendRandomSuffix, sanitizeNickname } from './nickname.util';
import { Channel } from './entities/channel.entity';

const PG_UNIQUE_VIOLATION = '23505';
const NICKNAME_COLUMN = 'nickname';
const MAX_RETRIES = 5;

interface PgDriverErrorFields {
  code?: unknown;
  detail?: unknown;
}

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  // QueryFailedError copies the pg driver error fields (code, detail) onto itself.
  const { code, detail } = err as QueryFailedError & PgDriverErrorFields;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}

@Injectable()
export class ChannelsService {
  constructor(private readonly dataSource: DataSource) {}

  /** Id of the user's channel, or `null` when the user has none. */
  async findIdByUserId(userId: string): Promise<string | null> {
    const channel = await this.dataSource.manager.findOne(Channel, {
      select: { id: true },
      where: { user_id: userId },
    });
    return channel?.id ?? null;
  }

  /**
   * Same lookup, locking the channel row (`FOR UPDATE`) until the caller's
   * transaction ends. `manager` must belong to an open transaction.
   */
  async lockIdByUserId(
    manager: EntityManager,
    userId: string,
  ): Promise<string | null> {
    const channel = await manager.findOne(Channel, {
      select: { id: true },
      where: { user_id: userId },
      lock: { mode: 'pessimistic_write' },
    });
    return channel?.id ?? null;
  }

  async createChannel(userId: string, email: string): Promise<Channel> {
    const baseNickname = sanitizeNickname(email.split('@')[0]);

    return this.dataSource.transaction(async (manager) => {
      let nickname = baseNickname;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const existing = await manager.findOne(Channel, {
          where: { nickname },
        });
        if (existing) {
          nickname = appendRandomSuffix(baseNickname);
          continue;
        }

        try {
          return await manager.save(
            manager.create(Channel, {
              name: baseNickname,
              nickname,
              user_id: userId,
            }),
          );
        } catch (err) {
          if (isPgUniqueViolationOnColumn(err, NICKNAME_COLUMN)) {
            // Concurrent insert between pre-check and save — retry with new suffix
            nickname = appendRandomSuffix(baseNickname);
          } else {
            throw err;
          }
        }
      }

      throw new Error(
        'Nickname conflict could not be resolved after max retries',
      );
    });
  }
}

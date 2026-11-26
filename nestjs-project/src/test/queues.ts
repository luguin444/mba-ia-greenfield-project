import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { TEST_ENV_OVERRIDES } from './setup-test-env';

/**
 * Wipes and closes the video queues of a test module, for `afterAll`.
 *
 * Refuses to touch queues outside the Jest prefix, so a misconfigured run can
 * never obliterate the queues the containers use. Workers are closed by Nest's
 * own shutdown hooks when the caller closes the module/app afterwards.
 */
export async function obliterateTestQueues(
  moduleRef: INestApplicationContext,
): Promise<void> {
  for (const name of QUEUE_NAMES) {
    const queue = moduleRef.get<Queue>(getQueueToken(name), { strict: false });
    if (queue.opts.prefix !== TEST_ENV_OVERRIDES.QUEUE_PREFIX) {
      throw new Error(
        `Refusing to obliterate queue "${name}" with prefix "${queue.opts.prefix}"`,
      );
    }
    await queue.obliterate({ force: true });
    await queue.close();
  }
}

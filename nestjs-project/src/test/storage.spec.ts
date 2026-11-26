import type { INestApplicationContext } from '@nestjs/common';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { resetVideoTestBuckets } from './storage';

describe('resetVideoTestBuckets', () => {
  function moduleWith(
    videosBucket: string,
    thumbnailsBucket: string,
    send: jest.Mock,
  ): INestApplicationContext {
    const providers = new Map<unknown, unknown>([
      [storageConfig.KEY, { videosBucket, thumbnailsBucket }],
      [S3_INTERNAL_CLIENT, { send }],
    ]);
    return {
      get: (token: unknown) => providers.get(token),
    } as unknown as INestApplicationContext;
  }

  it.each([
    ['videos', 'thumbnails-test'],
    ['videos-test', 'thumbnails'],
  ])(
    'should refuse to touch storage when a bucket is not test-scoped (%s, %s)',
    async (videosBucket, thumbnailsBucket) => {
      const send = jest.fn();

      await expect(
        resetVideoTestBuckets(moduleWith(videosBucket, thumbnailsBucket, send)),
      ).rejects.toThrow(/Refusing to reset bucket/);
      expect(send).not.toHaveBeenCalled();
    },
  );
});

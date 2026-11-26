import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  paginateListObjectsV2,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { INestApplicationContext } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';

const TEST_BUCKET_SUFFIX = '-test';

/**
 * Empties the test buckets of a test module, for `afterAll` (before closing the
 * module, which destroys the S3 clients).
 *
 * Aborts every open multipart upload and deletes every object in the videos and
 * thumbnails buckets the module is configured with. Refuses to run unless both
 * names end in `-test`, so a misconfigured run can never wipe the buckets the
 * containers use.
 */
export async function resetVideoTestBuckets(
  moduleRef: INestApplicationContext,
): Promise<void> {
  const config = moduleRef.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
    { strict: false },
  );
  const buckets = [config.videosBucket, config.thumbnailsBucket];
  for (const bucket of buckets) {
    if (!bucket.endsWith(TEST_BUCKET_SUFFIX)) {
      throw new Error(`Refusing to reset bucket "${bucket}"`);
    }
  }

  const client = moduleRef.get<S3Client>(S3_INTERNAL_CLIENT, {
    strict: false,
  });
  for (const bucket of buckets) {
    await abortAllMultipartUploads(client, bucket);
    await deleteAllObjects(client, bucket);
  }
}

/** The SDK ships no paginator for `ListMultipartUploads`, so it pages by markers. */
async function abortAllMultipartUploads(
  client: S3Client,
  bucket: string,
): Promise<void> {
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const page = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );
    for (const { Key, UploadId } of page.Uploads ?? []) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key,
          UploadId,
        }),
      );
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker);
}

/**
 * One `DeleteObject` per key: `DeleteObjects` sends the SDK's default CRC
 * checksum, which S3-compatible stores do not all accept.
 */
async function deleteAllObjects(
  client: S3Client,
  bucket: string,
): Promise<void> {
  for await (const page of paginateListObjectsV2(
    { client },
    { Bucket: bucket },
  )) {
    for (const { Key } of page.Contents ?? []) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
    }
  }
}

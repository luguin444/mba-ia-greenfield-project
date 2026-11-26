import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { MultipartUploadNotFoundError } from './storage.errors';

export interface UploadedPart {
  partNumber: number;
  eTag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

export interface ObjectHead {
  contentLength: number;
  contentType: string | null;
}

export interface PresignGetObjectOptions {
  /** `public` for URLs handed to clients, `internal` for our own processes. */
  client: 'public' | 'internal';
  /** Sets `Content-Disposition` on the response (download). */
  disposition?: string;
}

function isS3Error(error: unknown, ...names: string[]): boolean {
  return error instanceof S3ServiceException && names.includes(error.name);
}

/**
 * Every S3 operation of the videos feature. Multipart and video presigns target
 * the private videos bucket; object helpers take the bucket explicitly.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly videosBucket: string;

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.videosBucket = config.videosBucket;
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  /**
   * `contentType` is applied by S3 to the completed object, so presigned GETs
   * of the source answer with the declared `video/*` type.
   */
  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for ${key}`);
    }
    return UploadId;
  }

  async listAllParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.videosBucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber ?? 0,
          eTag: part.ETag ?? '',
          size: part.Size ?? 0,
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  /** Throws `MultipartUploadNotFoundError` when the upload is already gone. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.videosBucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.eTag,
            })),
          },
        }),
      );
    } catch (error) {
      if (isS3Error(error, 'NoSuchUpload')) {
        throw new MultipartUploadNotFoundError(key, uploadId);
      }
      throw error;
    }
  }

  /** Idempotent: an upload that is already gone (`NoSuchUpload`) is not an error. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.videosBucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (!isS3Error(error, 'NoSuchUpload')) throw error;
    }
  }

  /** Returns `null` when the object does not exist. */
  async headObject(bucket: string, key: string): Promise<ObjectHead | null> {
    try {
      const head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
      };
    } catch (error) {
      if (isS3Error(error, 'NotFound', 'NoSuchKey')) return null;
      throw error;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  async putObject(
    bucket: string,
    key: string,
    body: PutObjectCommandInput['Body'],
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Unsigned, path-style URL of an object in a public-read bucket. */
  publicObjectUrl(bucket: string, key: string): string {
    const base = this.config.publicEndpoint.replace(/\/+$/, '');
    return `${base}/${bucket}/${key}`;
  }

  /** Part URLs always reach the browser, so they are signed by the public client. */
  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async presignGetObject(
    key: string,
    ttlSeconds: number,
    options: PresignGetObjectOptions,
  ): Promise<string> {
    const client =
      options.client === 'public' ? this.publicClient : this.internalClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.videosBucket,
        Key: key,
        ResponseContentDisposition: options.disposition,
      }),
      { expiresIn: ttlSeconds },
    );
  }
}

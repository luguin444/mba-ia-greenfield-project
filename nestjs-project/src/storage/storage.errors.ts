/**
 * The multipart upload no longer exists in storage (S3 `NoSuchUpload`): it was
 * already completed or aborted. Callers map it to their own domain state.
 */
export class MultipartUploadNotFoundError extends Error {
  constructor(key: string, uploadId: string) {
    super(`Multipart upload ${uploadId} of ${key} no longer exists`);
    this.name = 'MultipartUploadNotFoundError';
  }
}

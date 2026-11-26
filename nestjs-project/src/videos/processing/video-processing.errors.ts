/**
 * The uploaded source object is gone from storage. Permanent: retrying cannot
 * bring it back, so the video fails with `PROCESSING_ERROR`.
 */
export class SourceObjectMissingError extends Error {
  constructor(key: string) {
    super(`Source object ${key} does not exist`);
    this.name = 'SourceObjectMissingError';
  }
}

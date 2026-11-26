import { DomainException } from '../common/exceptions/domain.exception';

/** How many missing part numbers `UploadIncompleteException` lists. */
export const MAX_LISTED_MISSING_PARTS = 20;

export class VideoTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_TOO_LARGE', 413, 'Video exceeds the maximum upload size');
  }
}

export class ActiveUploadLimitReachedException extends DomainException {
  constructor() {
    super(
      'ACTIVE_UPLOAD_LIMIT_REACHED',
      409,
      'Too many uploads in progress for this channel',
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super(
      'CHANNEL_NOT_FOUND',
      404,
      'Channel not found for the authenticated user',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class InvalidVideoStateException extends DomainException {
  constructor() {
    super(
      'INVALID_VIDEO_STATE',
      409,
      'Operation not allowed in the current video state',
    );
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super('INVALID_PART_NUMBER', 400, 'Part number out of range');
  }
}

export class UploadIncompleteException extends DomainException {
  constructor(missingPartNumbers: number[]) {
    const listed = missingPartNumbers.slice(0, MAX_LISTED_MISSING_PARTS);
    const suffix =
      missingPartNumbers.length > MAX_LISTED_MISSING_PARTS ? ', …' : '';
    super(
      'UPLOAD_INCOMPLETE',
      409,
      `Upload is missing parts: ${listed.join(', ')}${suffix}`,
    );
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      422,
      'Uploaded size does not match the declared size',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}

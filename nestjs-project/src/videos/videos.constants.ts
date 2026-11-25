/** Most part URLs signed in one response (initiate and `part-urls`). */
export const MAX_SIGNED_PARTS_PER_BATCH = 100;

/** S3 caps a multipart upload at 10,000 parts; `partSize` grows to fit. */
export const MAX_UPLOAD_PARTS = 10000;

/** Attempts to insert a video with a fresh `public_id` on a unique collision. */
export const MAX_PUBLIC_ID_ATTEMPTS = 5;

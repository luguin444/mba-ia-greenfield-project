/** S3 client for SDK calls made by our processes (`S3_ENDPOINT`). */
export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');

/**
 * S3 client used only to sign URLs handed to browsers (`S3_PUBLIC_ENDPOINT`).
 * The host is part of the SigV4 signature, so it cannot be rewritten later.
 */
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

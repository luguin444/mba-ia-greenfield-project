import { randomBytes } from 'crypto';

/** 8 random bytes in base64url: always 11 characters, 64 bits of entropy. */
export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}

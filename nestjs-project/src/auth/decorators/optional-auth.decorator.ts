import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Public } from './public.decorator';

export const IS_OPTIONAL_AUTH_KEY = 'isOptionalAuth';

/**
 * Public route that still identifies the caller when a token is sent.
 *
 * No `Authorization` header → anonymous (`request.user` undefined). A token that
 * verifies → `request.user` is set. A token that fails verification → 401, never
 * a silent downgrade to anonymous, so an expired session still triggers refresh.
 */
export const OptionalAuth = () =>
  applyDecorators(Public(), SetMetadata(IS_OPTIONAL_AUTH_KEY, true));

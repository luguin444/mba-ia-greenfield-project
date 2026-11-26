import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { IS_OPTIONAL_AUTH_KEY } from '../decorators/optional-auth.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

const TEST_SECRET = 'test-secret';

const STUB_HANDLER = jest.fn();
const STUB_CLASS = class {};

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => STUB_HANDLER,
    getClass: () => STUB_CLASS,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: JwtService;
  let mockReflector: { getAllAndOverride: jest.Mock };
  let metadata: Record<string, boolean | undefined>;

  beforeAll(async () => {
    mockReflector = { getAllAndOverride: jest.fn() };

    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_SECRET,
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [
        JwtAuthGuard,
        { provide: Reflector, useValue: mockReflector },
      ],
    }).compile();

    guard = module.get(JwtAuthGuard);
    jwtService = module.get(JwtService);
  });

  beforeEach(() => {
    metadata = {};
    mockReflector.getAllAndOverride.mockImplementation(
      (key: string) => metadata[key],
    );
  });

  it('bypasses guard on @Public() routes without reading the Authorization header', async () => {
    metadata = { [IS_PUBLIC_KEY]: true };
    const readHeaders = jest.fn(() => ({ authorization: 'Bearer anything' }));
    const request = {};
    Object.defineProperty(request, 'headers', { get: readHeaders });

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(readHeaders).not.toHaveBeenCalled();
  });

  it('passes with a valid JWT and attaches payload to request.user', async () => {
    const token = jwtService.sign({ sub: 'user-1', email: 'a@example.com' });
    const request: Record<string, unknown> = {
      headers: { authorization: `Bearer ${token}` },
    };
    const ctx = makeContext(request);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((request.user as Record<string, unknown>)?.sub).toBe('user-1');
    expect((request.user as Record<string, unknown>)?.email).toBe(
      'a@example.com',
    );
  });

  it('throws UnauthorizedException when Authorization header is missing', async () => {
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException on malformed Bearer token', async () => {
    const ctx = makeContext({
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException on expired JWT', async () => {
    const expiredToken = jwtService.sign(
      { sub: 'user-1', email: 'a@example.com' },
      { expiresIn: -60 },
    );
    const ctx = makeContext({
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  describe('@OptionalAuth() routes', () => {
    beforeEach(() => {
      metadata = { [IS_PUBLIC_KEY]: true, [IS_OPTIONAL_AUTH_KEY]: true };
    });

    it('lets an anonymous request through with no user when Authorization is missing', async () => {
      const request: Record<string, unknown> = { headers: {} };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('treats a non-Bearer Authorization header as anonymous', async () => {
      const request: Record<string, unknown> = {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('attaches the payload to request.user when the token verifies', async () => {
      const token = jwtService.sign({ sub: 'user-1', email: 'a@example.com' });
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.user).toMatchObject({
        sub: 'user-1',
        email: 'a@example.com',
      });
    });

    it('throws UnauthorizedException on an expired token instead of degrading to anonymous', async () => {
      const expiredToken = jwtService.sign(
        { sub: 'user-1', email: 'a@example.com' },
        { expiresIn: -60 },
      );
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${expiredToken}` },
      };

      await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(request.user).toBeUndefined();
    });

    it('throws UnauthorizedException on an invalid token', async () => {
      const request: Record<string, unknown> = {
        headers: { authorization: 'Bearer not-a-valid-jwt' },
      };

      await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';
import { IS_OPTIONAL_AUTH_KEY } from '../decorators/optional-auth.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

interface AuthRequest {
  headers: Record<string, string>;
  user: unknown;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    // Checked before `isPublic`: `@OptionalAuth()` also sets the public flag.
    const isOptionalAuth = this.reflector.getAllAndOverride<boolean>(
      IS_OPTIONAL_AUTH_KEY,
      targets,
    );
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      targets,
    );
    if (isPublic && !isOptionalAuth) return true;

    const request = context.switchToHttp().getRequest<AuthRequest>();
    const authHeader = request.headers?.authorization;

    if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
      if (isOptionalAuth) return true;
      throw new UnauthorizedException();
    }

    request.user = await this.verify(authHeader.slice(BEARER_PREFIX.length));
    return true;
  }

  private async verify(token: string): Promise<JwtPayload> {
    try {
      return await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException();
    }
  }
}

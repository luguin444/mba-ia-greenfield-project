import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { obliterateTestQueues } from '../../src/test/queues';
import { resetVideoTestBuckets } from '../../src/test/storage';
import type { InitiateUploadResponseDto } from '../../src/videos/dto/initiate-upload-response.dto';
import {
  Video,
  VideoProcessingStatus,
} from '../../src/videos/entities/video.entity';

/** Shared setup of the video e2e suites (one app per suite, `main.ts` globals reproduced). */
export interface VideosE2eContext {
  app: INestApplication<App>;
  moduleFixture: TestingModule;
  dataSource: DataSource;
  throttlerStorage: ThrottlerStorageService;
}

export interface TestUser {
  userId: string;
  email: string;
  accessToken: string;
}

export const DEFAULT_PASSWORD = 'password123';

export async function createVideosE2eApp(): Promise<VideosE2eContext> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return {
    app,
    moduleFixture,
    dataSource: moduleFixture.get(DataSource),
    throttlerStorage:
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage),
  };
}

export async function closeVideosE2eApp(ctx: VideosE2eContext): Promise<void> {
  try {
    await obliterateTestQueues(ctx.moduleFixture);
    await resetVideoTestBuckets(ctx.moduleFixture);
  } finally {
    await ctx.app.close();
  }
}

/** Registers (capturing the confirmation token instead of emailing it), confirms and logs in. */
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
): Promise<TestUser> {
  const authService = app.get(AuthService);
  let confirmationToken = '';
  const sendSpy = jest
    .spyOn(authService['mailService'], 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  const registered = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: DEFAULT_PASSWORD })
    .expect(201);
  sendSpy.mockRestore();
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: DEFAULT_PASSWORD })
    .expect(200);

  return {
    userId: (registered.body as { id: string }).id,
    email,
    accessToken: (login.body as { access_token: string }).access_token,
  };
}

/** A token signed with the real secret that expired a minute ago. */
export function expiredAccessToken(
  app: INestApplication<App>,
  user: TestUser,
): string {
  return app
    .get(JwtService)
    .sign({ sub: user.userId, email: user.email }, { expiresIn: -60 });
}

export async function initiateUpload(
  app: INestApplication<App>,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<InitiateUploadResponseDto> {
  const res = await request(app.getHttpServer())
    .post('/videos/uploads')
    .set('Authorization', `Bearer ${accessToken}`)
    .send(body)
    .expect(201);
  return res.body as InitiateUploadResponseDto;
}

/** PUTs `size` bytes straight to a presigned part URL (never through the API). */
export async function putPart(url: string, size: number): Promise<Response> {
  return fetch(url, {
    method: 'PUT',
    body: new Uint8Array(Buffer.alloc(size, 7)),
  });
}

/** Initiates a single-part upload of `sizeBytes`, PUTs it and completes it (video → `processing`). */
export async function uploadAndComplete(
  app: INestApplication<App>,
  accessToken: string,
  fileName: string,
  sizeBytes = 1048576,
): Promise<InitiateUploadResponseDto> {
  const initiated = await initiateUpload(app, accessToken, {
    fileName,
    sizeBytes,
    mimeType: 'video/mp4',
  });
  const put = await putPart(initiated.parts[0].url, sizeBytes);
  expect(put.status).toBe(200);
  await request(app.getHttpServer())
    .post(`/videos/${initiated.videoId}/upload/complete`)
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(202);
  return initiated;
}

/** Does what the worker does at the end of processing (it does not run in these suites). */
export async function markVideoReady(
  dataSource: DataSource,
  videoId: string,
): Promise<void> {
  await dataSource.getRepository(Video).update(
    { id: videoId },
    {
      processing_status: VideoProcessingStatus.READY,
      processed_at: () => 'CURRENT_TIMESTAMP',
    },
  );
}

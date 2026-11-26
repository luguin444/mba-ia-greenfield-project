import request from 'supertest';
import { Video } from '../src/videos/entities/video.entity';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import type { InitiateUploadResponseDto } from '../src/videos/dto/initiate-upload-response.dto';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  closeVideosE2eApp,
  createVideosE2eApp,
  expiredAccessToken,
  putPart,
  registerConfirmAndLogin,
  type TestUser,
  type VideosE2eContext,
} from './support/videos-e2e';

const MIB = 1024 * 1024;
const TEST_MAX_UPLOAD_BYTES = 12582912;
const PART_URL_TTL_SECONDS = 3600;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID_BODY = {
  fileName: 'clip.mp4',
  sizeBytes: 11534336,
  mimeType: 'video/mp4',
};

describe('videos-uploads', () => {
  let ctx: VideosE2eContext;
  let owner: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    ctx = await createVideosE2eApp();
  });

  afterAll(async () => {
    await closeVideosE2eApp(ctx);
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    ctx.throttlerStorage.storage.clear();
    owner = await registerConfirmAndLogin(ctx.app, 'owner@example.com');
    other = await registerConfirmAndLogin(ctx.app, 'other@example.com');
  });

  function postUpload(token: string | null, body: Record<string, unknown>) {
    const req = request(ctx.app.getHttpServer()).post('/videos/uploads');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  }

  function videoRows(): Promise<Video[]> {
    return ctx.dataSource.getRepository(Video).find();
  }

  async function ownerChannelId(): Promise<string> {
    const [row] = await ctx.dataSource.query<{ id: string }[]>(
      'SELECT id FROM channels WHERE user_id = $1',
      [owner.userId],
    );
    return row.id;
  }

  // 1. Iniciar upload multipart

  it('inicia-upload-e-retorna-primeiro-lote-de-urls', async () => {
    const before = Date.now();
    const res = await postUpload(owner.accessToken, VALID_BODY).expect(201);

    const body = res.body as InitiateUploadResponseDto;
    expect(body.videoId).toMatch(UUID_PATTERN);
    expect(body.publicId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(typeof body.uploadId).toBe('string');
    expect(body.uploadId.length).toBeGreaterThan(0);
    expect(body.partSize).toBe(5242880);
    expect(body.partCount).toBe(3);
    expect(body.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    for (const part of body.parts) {
      const url = new URL(part.url);
      expect(url.host).toBe('minio.localhost:9000');
      expect(url.pathname).toBe(`/videos-test/${body.videoId}/source`);
    }
    const expiresAt = Date.parse(body.expiresAt);
    expect(new Date(expiresAt).toISOString()).toBe(body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + PART_URL_TTL_SECONDS * 1000 - 1000,
    );
    expect(expiresAt).toBeLessThanOrEqual(
      Date.now() + PART_URL_TTL_SECONDS * 1000 + 1000,
    );

    const row = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: body.videoId });
    expect(row).toMatchObject({
      processing_status: 'uploading',
      publication_status: 'draft',
      upload_id: body.uploadId,
      channel_id: await ownerChannelId(),
      original_filename: 'clip.mp4',
      size_bytes: 11534336,
      failure_reason: null,
    });

    const put = await putPart(body.parts[0].url, 5 * MIB);
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
  });

  it('usuario-sem-canal-recebe-404-channel-not-found', async () => {
    await ctx.dataSource.query('DELETE FROM channels WHERE user_id = $1', [
      owner.userId,
    ]);

    const res = await postUpload(owner.accessToken, VALID_BODY).expect(404);

    expect(res.body).toEqual({
      statusCode: 404,
      error: 'CHANNEL_NOT_FOUND',
      message: 'Channel not found for the authenticated user',
    });
    expect(await videoRows()).toHaveLength(0);
  });

  it('titulo-padrao-do-filename-e-titulo-informado-com-trim', async () => {
    const withoutTitle = await postUpload(owner.accessToken, {
      ...VALID_BODY,
      fileName: 'aula-01.mp4',
    }).expect(201);
    const defaultRow = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({
        id: (withoutTitle.body as InitiateUploadResponseDto).videoId,
      });
    expect(defaultRow.title).toBe('aula-01');

    const withTitle = await postUpload(owner.accessToken, {
      ...VALID_BODY,
      fileName: 'aula-02.mp4',
      title: '  Minha aula  ',
    }).expect(201);
    const titledRow = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({
        id: (withTitle.body as InitiateUploadResponseDto).videoId,
      });
    expect(titledRow.title).toBe('Minha aula');
  });

  // 2. Regras de domínio (tamanho e teto de uploads ativos)

  it('tamanho-acima-do-teto-retorna-413', async () => {
    const tooLarge = await postUpload(owner.accessToken, {
      ...VALID_BODY,
      sizeBytes: TEST_MAX_UPLOAD_BYTES + 1,
    }).expect(413);
    expect(tooLarge.body).toEqual({
      statusCode: 413,
      error: 'VIDEO_TOO_LARGE',
      message: 'Video exceeds the maximum upload size',
    });
    expect(await videoRows()).toHaveLength(0);

    await postUpload(owner.accessToken, {
      ...VALID_BODY,
      sizeBytes: TEST_MAX_UPLOAD_BYTES,
    }).expect(201);
  });

  it('canal-no-teto-de-uploads-ativos-retorna-409', async () => {
    for (let i = 0; i < 5; i++) {
      await postUpload(owner.accessToken, VALID_BODY).expect(201);
    }

    const res = await postUpload(owner.accessToken, VALID_BODY).expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      error: 'ACTIVE_UPLOAD_LIMIT_REACHED',
      message: 'Too many uploads in progress for this channel',
    });
    const [{ count }] = await ctx.dataSource.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM videos
       WHERE channel_id = $1 AND processing_status = 'uploading'`,
      [await ownerChannelId()],
    );
    expect(count).toBe(5);

    await postUpload(other.accessToken, VALID_BODY).expect(201);
  });

  // 3. Validação de entrada

  it('body-invalido-retorna-400-validation-error', async () => {
    const invalidBodies: Record<string, unknown>[] = [
      { ...VALID_BODY, mimeType: 'image/png' },
      { ...VALID_BODY, channelId: 'some-channel' },
      { ...VALID_BODY, sizeBytes: 0 },
      { ...VALID_BODY, fileName: '' },
    ];

    for (const body of invalidBodies) {
      const res = await postUpload(owner.accessToken, body).expect(400);
      const envelope = res.body as ApiErrorEnvelope;
      expect(envelope.error).toBe('VALIDATION_ERROR');
      expect(Array.isArray(envelope.message)).toBe(true);
      for (const message of envelope.message as unknown[]) {
        expect(typeof message).toBe('string');
      }
    }
    expect(await videoRows()).toHaveLength(0);
  });

  // 4. Autenticação e throttling

  it('sem-token-ou-token-expirado-retorna-401', async () => {
    await postUpload(null, VALID_BODY).expect(401);
    await postUpload(expiredAccessToken(ctx.app, owner), VALID_BODY).expect(
      401,
    );

    expect(await videoRows()).toHaveLength(0);
  });

  it('chamadas-em-sequencia-nunca-recebem-429', async () => {
    ctx.throttlerStorage.storage.clear();
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await postUpload(owner.accessToken, VALID_BODY);
      statuses.push(res.status);
      if (res.status === 409) {
        expect((res.body as ApiErrorEnvelope).error).toBe(
          'ACTIVE_UPLOAD_LIMIT_REACHED',
        );
      }
    }

    expect(statuses).not.toContain(429);
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses.slice(5)).toEqual(Array<number>(10).fill(409));
  });
});

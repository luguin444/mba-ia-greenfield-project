import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { cleanAllTables } from '../src/test/create-test-data-source';
import type { SignedUrlResponseDto } from '../src/videos/dto/signed-url-response.dto';
import { generatePublicId } from '../src/videos/public-id.util';
import {
  closeVideosE2eApp,
  createVideosE2eApp,
  expiredAccessToken,
  markVideoReady,
  registerConfirmAndLogin,
  uploadAndComplete,
  type TestUser,
  type VideosE2eContext,
} from './support/videos-e2e';

const SIZE_BYTES = 1048576;
const VIDEO_NOT_FOUND: ApiErrorEnvelope = {
  statusCode: 404,
  error: 'VIDEO_NOT_FOUND',
  message: 'Video not found',
};
const QUOTED_FILENAME = /filename="([^"]*)"/;
const ENCODED_FILENAME = /filename\*=UTF-8''(\S+)/;

describe('videos-download', () => {
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

  /** Owner's video, uploaded and moved to `ready` as the worker would. */
  async function readyVideo(
    fileName: string,
  ): Promise<{ videoId: string; publicId: string }> {
    const uploaded = await uploadAndComplete(
      ctx.app,
      owner.accessToken,
      fileName,
      SIZE_BYTES,
    );
    await markVideoReady(ctx.dataSource, uploaded.videoId);
    return uploaded;
  }

  function getDownload(id: string, token: string | null) {
    const req = request(ctx.app.getHttpServer()).get(`/videos/${id}/download`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  async function downloadDisposition(publicId: string): Promise<string> {
    const res = await getDownload(publicId, owner.accessToken).expect(200);
    const file = await fetch((res.body as SignedUrlResponseDto).url);
    expect(file.status).toBe(200);
    return file.headers.get('content-disposition') ?? '';
  }

  // 1. Download pelo dono

  it('dono-com-video-ready-baixa-com-attachment', async () => {
    const { videoId, publicId } = await readyVideo('meu-video.mp4');

    const res = await getDownload(publicId, owner.accessToken).expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as SignedUrlResponseDto;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'url']);
    const url = new URL(body.url);
    expect(url.host).toBe('minio.localhost:9000');
    expect(url.pathname).toBe(`/videos-test/${videoId}/source`);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();

    const file = await fetch(body.url);
    expect(file.status).toBe(200);
    const disposition = file.headers.get('content-disposition') ?? '';
    expect(disposition).toBe(
      `attachment; filename="meu-video.mp4"; filename*=UTF-8''meu-video.mp4`,
    );
    expect((await file.arrayBuffer()).byteLength).toBe(SIZE_BYTES);
  });

  it('nome-com-acentos-gera-filename-ascii-e-filename-estrela-utf8', async () => {
    const fileName = 'Férias em São Paulo 🎬.mp4';
    const { publicId } = await readyVideo(fileName);

    const disposition = await downloadDisposition(publicId);

    const ascii = QUOTED_FILENAME.exec(disposition)?.[1];
    expect(ascii).toMatch(/^[\x20-\x7e]+\.mp4$/);
    const encoded = ENCODED_FILENAME.exec(disposition)?.[1] ?? '';
    expect(decodeURIComponent(encoded)).toBe(fileName);
  });

  // 2. Visibilidade e estado (os 4 casos de optional-auth)

  it('anonimo-e-nao-dono-em-rascunho-recebem-404-identico', async () => {
    const { publicId } = await readyVideo('clip.mp4');

    const anonymous = await getDownload(publicId, null).expect(404);
    expect(anonymous.body).toEqual(VIDEO_NOT_FOUND);
    const nonOwner = await getDownload(publicId, other.accessToken).expect(404);
    expect(nonOwner.body).toEqual(anonymous.body);
    const missing = await getDownload(generatePublicId(), null).expect(404);
    expect(missing.body).toEqual(anonymous.body);
    const malformed = await getDownload('abc12', owner.accessToken).expect(404);
    expect(malformed.body).toEqual(VIDEO_NOT_FOUND);
  });

  it('token-expirado-recebe-401', async () => {
    const { publicId } = await readyVideo('clip.mp4');

    await getDownload(publicId, expiredAccessToken(ctx.app, owner)).expect(401);
  });

  it('dono-com-video-nao-ready-recebe-409', async () => {
    const processing = await uploadAndComplete(
      ctx.app,
      owner.accessToken,
      'second.mp4',
      SIZE_BYTES,
    );

    const res = await getDownload(
      processing.publicId,
      owner.accessToken,
    ).expect(409);

    expect(res.body).toEqual({
      statusCode: 409,
      error: 'VIDEO_NOT_READY',
      message: 'Video is not ready for playback',
    });
  });
});

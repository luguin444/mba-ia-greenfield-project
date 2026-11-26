import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { cleanAllTables } from '../src/test/create-test-data-source';
import type { SignedUrlResponseDto } from '../src/videos/dto/signed-url-response.dto';
import { generatePublicId } from '../src/videos/public-id.util';
import {
  closeVideosE2eApp,
  createVideosE2eApp,
  expiredAccessToken,
  initiateUpload,
  markVideoReady,
  registerConfirmAndLogin,
  uploadAndComplete,
  type TestUser,
  type VideosE2eContext,
} from './support/videos-e2e';

const SIZE_BYTES = 1048576;
const PLAYBACK_TTL_SECONDS = 14400;
const VIDEO_NOT_FOUND: ApiErrorEnvelope = {
  statusCode: 404,
  error: 'VIDEO_NOT_FOUND',
  message: 'Video not found',
};

describe('videos-playback', () => {
  let ctx: VideosE2eContext;
  let owner: TestUser;
  let other: TestUser;
  let videoId: string;
  let publicId: string;

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
    const ready = await uploadAndComplete(
      ctx.app,
      owner.accessToken,
      'clip.mp4',
      SIZE_BYTES,
    );
    await markVideoReady(ctx.dataSource, ready.videoId);
    videoId = ready.videoId;
    publicId = ready.publicId;
  });

  function getPlayback(id: string, token: string | null) {
    const req = request(ctx.app.getHttpServer()).get(`/videos/${id}/playback`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  }

  async function missingVideoBody(): Promise<unknown> {
    const res = await getPlayback(generatePublicId(), null).expect(404);
    return res.body;
  }

  // 1. Acesso por visibilidade (os 4 casos de optional-auth)

  it('dono-com-video-ready-recebe-url-que-responde-206', async () => {
    const before = Date.now();

    const res = await getPlayback(publicId, owner.accessToken).expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as SignedUrlResponseDto;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'url']);
    const url = new URL(body.url);
    expect(url.host).toBe('minio.localhost:9000');
    expect(url.pathname).toBe(`/videos-test/${videoId}/source`);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Expires')).toBe(
      String(PLAYBACK_TTL_SECONDS),
    );
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + PLAYBACK_TTL_SECONDS * 1000,
    );
    expect(expiresAt).toBeLessThanOrEqual(
      Date.now() + PLAYBACK_TTL_SECONDS * 1000,
    );

    const media = await fetch(body.url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(media.status).toBe(206);
    expect(media.headers.get('content-range')).toBe(
      `bytes 0-1023/${SIZE_BYTES}`,
    );
    expect((await media.arrayBuffer()).byteLength).toBe(1024);
  });

  it('anonimo-em-rascunho-recebe-404-identico-a-inexistente', async () => {
    const res = await getPlayback(publicId, null).expect(404);

    expect(res.body).toEqual(VIDEO_NOT_FOUND);
    expect(res.body).toEqual(await missingVideoBody());
  });

  it('nao-dono-em-rascunho-recebe-404-identico', async () => {
    const res = await getPlayback(publicId, other.accessToken).expect(404);

    expect(res.body).toEqual(VIDEO_NOT_FOUND);
    expect(res.body).toEqual(await missingVideoBody());
  });

  it('token-expirado-ou-invalido-recebe-401', async () => {
    await getPlayback(publicId, expiredAccessToken(ctx.app, owner)).expect(401);
    await getPlayback(publicId, 'not-a-jwt').expect(401);
  });

  // 2. Estado do vídeo e formato do publicId

  it('publicid-malformado-recebe-404', async () => {
    const shortId = await getPlayback('abc12', owner.accessToken).expect(404);
    expect(shortId.body).toEqual(await missingVideoBody());

    const longId = await getPlayback('abcdefghijkl', null).expect(404);
    expect(longId.body).toEqual(VIDEO_NOT_FOUND);
  });

  it('dono-com-video-nao-ready-recebe-409', async () => {
    const processing = await uploadAndComplete(
      ctx.app,
      owner.accessToken,
      'second.mp4',
      SIZE_BYTES,
    );
    const uploading = await initiateUpload(ctx.app, owner.accessToken, {
      fileName: 'third.mp4',
      sizeBytes: SIZE_BYTES,
      mimeType: 'video/mp4',
    });

    const processingRes = await getPlayback(
      processing.publicId,
      owner.accessToken,
    ).expect(409);
    expect(processingRes.body).toEqual({
      statusCode: 409,
      error: 'VIDEO_NOT_READY',
      message: 'Video is not ready for playback',
    });
    const uploadingRes = await getPlayback(
      uploading.publicId,
      owner.accessToken,
    ).expect(409);
    expect(uploadingRes.body).toEqual({
      statusCode: 409,
      error: 'VIDEO_NOT_READY',
      message: 'Video is not ready for playback',
    });
    const otherRes = await getPlayback(
      processing.publicId,
      other.accessToken,
    ).expect(404);
    expect(otherRes.body).toEqual(VIDEO_NOT_FOUND);
  });
});

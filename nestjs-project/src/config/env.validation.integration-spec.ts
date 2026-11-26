import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://minio.localhost:9000',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key-123',
};

interface EnvValidationResult {
  error?: ValidationError;
  value: Record<string, unknown>;
}

const validate = (env: Record<string, string>): EnvValidationResult =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage keys', () => {
  it.each([
    'S3_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
  ])('should reject the env when %s is missing', (key) => {
    const env: Record<string, string | undefined> = { ...requiredEnv };
    delete env[key];

    const { error } = envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });

    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject S3_ENDPOINT when it is not a URI', () => {
    const { error } = validate({ S3_ENDPOINT: 'minio 9000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should reject S3_SECRET_KEY shorter than 8 characters', () => {
    const { error } = validate({ S3_SECRET_KEY: 'short' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_SECRET_KEY');
  });

  it('should accept S3_SECRET_KEY with exactly 8 characters', () => {
    const { error } = validate({ S3_SECRET_KEY: '12345678' });
    expect(error).toBeUndefined();
  });

  it('should apply defaults for region and buckets', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_REGION).toBe('us-east-1');
    expect(value.S3_VIDEOS_BUCKET).toBe('videos');
    expect(value.S3_THUMBNAILS_BUCKET).toBe('thumbnails');
  });
});

describe('envValidationSchema — queue keys', () => {
  it('should apply defaults for Redis host, port and queue prefix', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_PREFIX).toBe('bull');
  });

  it('should reject REDIS_PORT outside the port range', () => {
    const { error } = validate({ REDIS_PORT: '70000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});

describe('envValidationSchema — video keys', () => {
  it('should apply the documented defaults when video keys are omitted', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      VIDEO_MAX_UPLOAD_BYTES: 10737418240,
      VIDEO_UPLOAD_PART_SIZE_BYTES: 67108864,
      VIDEO_UPLOAD_PART_URL_TTL_SECONDS: 3600,
      VIDEO_PLAYBACK_URL_TTL_SECONDS: 14400,
      VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL: 5,
      VIDEO_SWEEP_INTERVAL_MS: 900000,
      VIDEO_UPLOAD_STALE_AFTER_MS: 86400000,
    });
  });

  it('should reject VIDEO_UPLOAD_PART_SIZE_BYTES below the 5 MiB S3 minimum', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });

  it('should accept VIDEO_UPLOAD_PART_SIZE_BYTES at the 5 MiB minimum', () => {
    const { value, error } = validate({
      VIDEO_UPLOAD_PART_SIZE_BYTES: '5242880',
    });
    expect(error).toBeUndefined();
    expect(value.VIDEO_UPLOAD_PART_SIZE_BYTES).toBe(5242880);
  });

  it('should reject VIDEO_UPLOAD_PART_SIZE_BYTES above the 5 GiB S3 maximum', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '5368709121' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });

  it.each([
    ['VIDEO_UPLOAD_PART_URL_TTL_SECONDS', '59'],
    ['VIDEO_UPLOAD_PART_URL_TTL_SECONDS', '604801'],
    ['VIDEO_PLAYBACK_URL_TTL_SECONDS', '59'],
    ['VIDEO_PLAYBACK_URL_TTL_SECONDS', '604801'],
  ])('should reject %s=%s outside the 60s–7d presign window', (key, raw) => {
    const { error } = validate({ [key]: raw });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject a non-integer VIDEO_MAX_UPLOAD_BYTES', () => {
    const { error } = validate({ VIDEO_MAX_UPLOAD_BYTES: '1.5' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_MAX_UPLOAD_BYTES');
  });
});

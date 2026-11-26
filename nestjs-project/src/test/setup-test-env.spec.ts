describe('setup-test-env', () => {
  const productionValues = {
    QUEUE_PREFIX: 'bull',
    S3_VIDEOS_BUCKET: 'videos',
    S3_THUMBNAILS_BUCKET: 'thumbnails',
    VIDEO_MAX_UPLOAD_BYTES: '10737418240',
    VIDEO_UPLOAD_PART_SIZE_BYTES: '67108864',
  };
  const expectedTestValues = {
    QUEUE_PREFIX: 'test',
    S3_VIDEOS_BUCKET: 'videos-test',
    S3_THUMBNAILS_BUCKET: 'thumbnails-test',
    VIDEO_MAX_UPLOAD_BYTES: '12582912',
    VIDEO_UPLOAD_PART_SIZE_BYTES: '5242880',
  };

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should already expose the test-scoped values inside the Jest process', () => {
    expect(process.env).toMatchObject(expectedTestValues);
  });

  it('should override production values loaded from .env', () => {
    Object.assign(process.env, productionValues);

    jest.isolateModules(() => {
      jest.requireActual('./setup-test-env');
    });

    expect(process.env).toMatchObject(expectedTestValues);
  });
});

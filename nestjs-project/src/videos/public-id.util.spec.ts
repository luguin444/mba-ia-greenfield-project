import { PUBLIC_ID_PATTERN, generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('should produce an 11-character base64url id matching PUBLIC_ID_PATTERN', () => {
    const publicId = generatePublicId();

    expect(publicId).toHaveLength(11);
    expect(publicId).toMatch(PUBLIC_ID_PATTERN);
  });

  it('should not repeat across 10,000 consecutive calls', () => {
    const ids = new Set(Array.from({ length: 10_000 }, generatePublicId));

    expect(ids.size).toBe(10_000);
    for (const id of ids) expect(id).toMatch(PUBLIC_ID_PATTERN);
  });
});

describe('PUBLIC_ID_PATTERN', () => {
  it.each(['abc', 'abcdefghijkl', 'abcdefghij=', 'abc/efghijk', 'abc+efghijk'])(
    'should reject %p',
    (value) => {
      expect(PUBLIC_ID_PATTERN.test(value)).toBe(false);
    },
  );

  it('should accept the base64url alphabet including - and _', () => {
    expect(PUBLIC_ID_PATTERN.test('aZ09-_aZ09-')).toBe(true);
  });
});

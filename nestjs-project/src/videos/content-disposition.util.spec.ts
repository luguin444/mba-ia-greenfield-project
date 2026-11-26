import { buildAttachmentDisposition } from './content-disposition.util';

function parts(disposition: string): { ascii: string; encoded: string } {
  const match =
    /^attachment; filename="([^"]*)"; filename\*=UTF-8''(\S+)$/.exec(
      disposition,
    );
  if (!match) throw new Error(`Unexpected disposition: ${disposition}`);
  return { ascii: match[1], encoded: match[2] };
}

describe('buildAttachmentDisposition', () => {
  it('should keep an ASCII-only name unchanged in both parameters', () => {
    expect(buildAttachmentDisposition('meu-video.mp4')).toBe(
      `attachment; filename="meu-video.mp4"; filename*=UTF-8''meu-video.mp4`,
    );
  });

  it('should drop accents and replace an emoji in the ASCII fallback, keeping the exact name in filename*', () => {
    const fileName = 'Férias em São Paulo 🎬.mp4';

    const { ascii, encoded } = parts(buildAttachmentDisposition(fileName));

    expect(ascii).toBe('Ferias em Sao Paulo _.mp4');
    expect(decodeURIComponent(encoded)).toBe(fileName);
  });

  it('should replace double quotes and backslashes in the ASCII fallback so the quoted-string stays closed', () => {
    const fileName = 'say "hi" \\ bye.mp4';

    const { ascii, encoded } = parts(buildAttachmentDisposition(fileName));

    expect(ascii).toBe('say _hi_ _ bye.mp4');
    expect(decodeURIComponent(encoded)).toBe(fileName);
  });

  it('should replace control characters so the header cannot be split', () => {
    const { ascii, encoded } = parts(
      buildAttachmentDisposition('a\r\nb\tc.mp4'),
    );

    expect(ascii).toBe('a__b_c.mp4');
    expect(encoded).toBe('a%0D%0Ab%09c.mp4');
  });

  it('should percent-encode UTF-8 bytes and the characters RFC 5987 does not allow in filename*', () => {
    const { encoded } = parts(buildAttachmentDisposition("it's (v2)*.mp4"));

    expect(encoded).toBe('it%27s%20%28v2%29%2A.mp4');
    expect(parts(buildAttachmentDisposition('ã.mp4')).encoded).toBe(
      '%C3%A3.mp4',
    );
  });
});

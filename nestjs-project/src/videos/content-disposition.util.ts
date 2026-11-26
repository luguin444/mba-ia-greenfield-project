const COMBINING_MARKS = /[̀-ͯ]/g;
// Printable ASCII minus the two characters that need escaping in a quoted-string.
// `u`: one `_` per code point, so an emoji (a surrogate pair) is not two.
const NOT_SAFE_IN_QUOTED_FILENAME = /[^\x20-\x21\x23-\x5b\x5d-\x7e]/gu;
// `encodeURIComponent` leaves these unescaped, but RFC 5987 `attr-char` does not allow them.
const NOT_RFC5987_ATTR_CHAR = /['()*]/g;

/** ASCII fallback for old clients: accents dropped, anything else unsafe → `_`. */
function asciiFileName(fileName: string): string {
  return fileName
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(NOT_SAFE_IN_QUOTED_FILENAME, '_');
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    NOT_RFC5987_ATTR_CHAR,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition` that downloads the file under its original name
 * (RFC 6266): `filename` for clients that only read ASCII, `filename*` with the
 * exact UTF-8 name for the rest.
 */
export function buildAttachmentDisposition(fileName: string): string {
  return `attachment; filename="${asciiFileName(fileName)}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

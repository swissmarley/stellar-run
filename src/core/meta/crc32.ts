/** CRC-32 (IEEE 802.3) of a string's UTF-16 code units. Detects corruption in saved data (not tampering). */
const TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c;
}

export function crc32(s: string): number {
  let c = -1;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    c = TABLE[(c ^ code) & 0xff]! ^ (c >>> 8);
    c = TABLE[(c ^ (code >>> 8)) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

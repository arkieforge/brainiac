// Crockford base32, as ULID specifies: no I, L, O or U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A new ULID: 10 characters of millisecond time, then 16 random ones, so ids sort by creation time.
 * Every note gets one in `id`, which sync keys on; the path can change, the id never does.
 */
export function ulid(
  now: number = Date.now(),
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  // 256 is a multiple of 32, so taking 5 bits of each byte stays uniform.
  const rest = Array.from(random.subarray(0, 16), (byte) => ALPHABET[byte % 32]).join("");
  return time + rest;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const isUlid = (value: string): boolean => ULID.test(value);

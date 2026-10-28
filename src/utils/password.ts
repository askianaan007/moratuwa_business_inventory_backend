import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt (memory-hard, built into Node — no native deps).
 * Stored format: scrypt$N$r$p$<salt b64>$<hash b64>, so parameters can be
 * raised later without breaking existing hashes.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, options: ScryptOptions, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P, maxmem: MAX_MEM }, KEY_LENGTH);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, "base64");
  const actual = await derive(
    password,
    Buffer.from(saltB64, "base64"),
    { N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_MEM },
    expected.length,
  );
  return timingSafeEqual(actual, expected);
}

/**
 * A real hash of a random password. Verifying against it when the user does
 * not exist keeps login timing the same, so emails cannot be enumerated.
 */
export const DUMMY_PASSWORD_HASH = await hashPassword(randomBytes(16).toString("hex"));

/** Strength rules shared by user creation and password change. */
export const PASSWORD_RULES = {
  minLength: 10,
  maxLength: 128,
  pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/,
  message: "Password must be 10–128 characters and include upper-case, lower-case and a number",
} as const;

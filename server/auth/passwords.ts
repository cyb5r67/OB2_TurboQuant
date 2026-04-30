// Password hashing — argon2id via hash-wasm.
//
// argon2id is the modern default (resistant to both time-memory and side-channel
// attacks). hash-wasm provides a pure-WASM implementation that works in Deno
// without native bindings.
//
// Parameters chosen for interactive auth on commodity hardware:
//   - Memory:     64 MB    (OWASP minimum recommendation)
//   - Iterations: 3
//   - Parallelism: 1       (single-core; fine for login rate)
//   - Hash length: 32 bytes
//
// At these settings each verify costs roughly 100-300 ms on a laptop —
// fast enough for login, slow enough to make brute-force offline attacks
// prohibitively expensive.

import { argon2id, argon2Verify } from "npm:hash-wasm@4.11.0";

const DEFAULT_PARAMS = {
  iterations: 3,
  parallelism: 1,
  memorySize: 65536, // 64 MB (KB units in hash-wasm)
  hashLength: 32,
};

/** Hash a plaintext password. Returns a self-describing argon2id string
 * (contains the algorithm, parameters, salt, and digest) — store this whole
 * string in the user record. */
export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return await argon2id({
    password,
    salt,
    ...DEFAULT_PARAMS,
    outputType: "encoded",
  });
}

/** Verify a plaintext password against a stored argon2id hash.
 * Returns true iff the password matches. Argon2's verification is
 * constant-time against the parameters encoded in the hash. */
export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  if (!storedHash || !password) return false;
  try {
    return await argon2Verify({ password, hash: storedHash });
  } catch {
    // Malformed hash or other decode failure — treat as non-match
    return false;
  }
}

/** Validate a password meets minimum complexity requirements. */
export function validatePasswordStrength(password: string): string | null {
  if (!password) return "password required";
  if (password.length < 8) return "password must be at least 8 characters";
  if (password.length > 256) return "password too long (max 256 chars)";
  return null;
}

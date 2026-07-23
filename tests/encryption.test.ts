/**
 * Unit tests for src/utils/encryption.ts (AES-256-GCM at-rest encryption).
 *
 * ENCRYPTION_SECRET must exist before the module is used, and the module reads
 * it through Bun.env (an alias of process.env) on every call, so it is set here
 * at module scope — before the import below is evaluated at runtime.
 */
import { describe, test, expect } from "bun:test";
import { Buffer } from "node:buffer";

// Throwaway test-only secret. 64 hex chars, satisfying the >= 32 char minimum.
const TEST_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.ENCRYPTION_SECRET = TEST_SECRET;

const { encrypt, decrypt } = await import("../src/utils/encryption.js");

// salt(32) + iv(16) + tag(16) = 64 bytes of header before the ciphertext.
const HEADER_BYTES = 64;

describe("encrypt / decrypt round trip", () => {
  test.each([
    ["ascii", "hello world"],
    ["a token-shaped string", "wth_1a2b3c4d5e6f7g8h9i0j"],
    ["json", JSON.stringify({ access_token: "abc", userid: 12345 })],
    ["unicode", "héllo wörld — 世界 🎉 Ω ñ"],
    ["emoji only", "🔐🧬🩺"],
    ["whitespace", "  \n\t  "],
    ["empty string", ""],
  ])("round trips %s", (_label, plaintext) => {
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  test("round trips a long string", () => {
    const long = "withings-".repeat(20000); // ~180 KB
    const ciphertext = encrypt(long);
    expect(decrypt(ciphertext)).toBe(long);
    expect(decrypt(ciphertext).length).toBe(long.length);
  });

  test("ciphertext is base64 and is not the plaintext", () => {
    const plaintext = "super-secret-refresh-token";
    const ciphertext = encrypt(plaintext);

    expect(ciphertext).not.toContain(plaintext);
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // Decoding and re-encoding is lossless => it really is valid base64.
    expect(Buffer.from(ciphertext, "base64").toString("base64")).toBe(ciphertext);
  });

  test("output carries the 64-byte salt+iv+tag header ahead of the ciphertext", () => {
    const raw = Buffer.from(encrypt("abc"), "base64");
    expect(raw.length).toBe(HEADER_BYTES + 3); // GCM is a stream mode: no padding
    expect(Buffer.from(encrypt(""), "base64").length).toBe(HEADER_BYTES);
  });
});

describe("randomness", () => {
  test("the same plaintext encrypts to different ciphertexts, both decryptable", () => {
    const plaintext = "identical input";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);

    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  test("salt and IV differ across operations", () => {
    const a = Buffer.from(encrypt("x"), "base64");
    const b = Buffer.from(encrypt("x"), "base64");

    expect(a.subarray(0, 32).equals(b.subarray(0, 32))).toBe(false); // salt
    expect(a.subarray(32, 48).equals(b.subarray(32, 48))).toBe(false); // iv
  });

  test("many encryptions of the same value are all distinct", () => {
    const outputs = new Set<string>();
    for (let i = 0; i < 25; i++) outputs.add(encrypt("same-value"));
    expect(outputs.size).toBe(25);
    for (const value of outputs) expect(decrypt(value)).toBe("same-value");
  });
});

describe("tamper detection (GCM auth tag)", () => {
  const flipByte = (ciphertext: string, index: number): string => {
    const raw = Buffer.from(ciphertext, "base64");
    raw[index] = raw[index]! ^ 0xff;
    return raw.toString("base64");
  };

  test("a flipped ciphertext byte fails authentication instead of returning garbage", () => {
    const ciphertext = encrypt("sensitive-withings-refresh-token");
    const tampered = flipByte(ciphertext, HEADER_BYTES + 2);

    expect(() => decrypt(tampered)).toThrow();
    expect(tampered).not.toBe(ciphertext);
  });

  test.each([
    ["salt", 0],
    ["iv", 32],
    ["auth tag", 48],
    ["ciphertext body", HEADER_BYTES],
  ])("a flipped byte in the %s is rejected", (_region, index) => {
    const ciphertext = encrypt("0123456789abcdef");
    expect(() => decrypt(flipByte(ciphertext, index))).toThrow();
  });

  test("truncating the ciphertext body is rejected", () => {
    const raw = Buffer.from(encrypt("0123456789abcdef"), "base64");
    const truncated = raw.subarray(0, raw.length - 4).toString("base64");
    expect(() => decrypt(truncated)).toThrow();
  });

  test("appending extra bytes is rejected", () => {
    const raw = Buffer.from(encrypt("0123456789abcdef"), "base64");
    const extended = Buffer.concat([raw, Buffer.from([0, 1, 2, 3])]).toString("base64");
    expect(() => decrypt(extended)).toThrow();
  });

  test("splicing the header of one ciphertext onto the body of another is rejected", () => {
    const a = Buffer.from(encrypt("alpha-value"), "base64");
    const b = Buffer.from(encrypt("beta-value!"), "base64");
    const spliced = Buffer.concat([
      a.subarray(0, HEADER_BYTES),
      b.subarray(HEADER_BYTES),
    ]).toString("base64");

    expect(() => decrypt(spliced)).toThrow();
  });

  test("a ciphertext produced under a different secret is rejected", () => {
    const ciphertext = encrypt("cross-secret");
    const original = process.env.ENCRYPTION_SECRET;
    try {
      process.env.ENCRYPTION_SECRET = "ffffffffffffffffffffffffffffffffffffffff";
      expect(() => decrypt(ciphertext)).toThrow();
    } finally {
      process.env.ENCRYPTION_SECRET = original;
    }
    // ...and still decrypts once the correct secret is restored.
    expect(decrypt(ciphertext)).toBe("cross-secret");
  });
});

describe("malformed input", () => {
  test.each([
    ["empty string", ""],
    ["not base64 at all", "not base64 !!!"],
    ["punctuation only", "$$$$"],
    ["short valid base64", "aGVsbG8="],
    ["exactly the header length", Buffer.alloc(HEADER_BYTES).toString("base64")],
    ["one byte short of the header", Buffer.alloc(HEADER_BYTES - 1).toString("base64")],
  ])("decrypt throws on %s", (_label, input) => {
    expect(() => decrypt(input)).toThrow();
  });

  test("decrypt never silently returns a partial plaintext for junk input", () => {
    let returned: string | undefined;
    try {
      returned = decrypt("Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy");
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });
});

describe("secret validation", () => {
  const withSecret = (value: string | undefined, fn: () => void) => {
    const original = process.env.ENCRYPTION_SECRET;
    try {
      if (value === undefined) delete process.env.ENCRYPTION_SECRET;
      else process.env.ENCRYPTION_SECRET = value;
      fn();
    } finally {
      process.env.ENCRYPTION_SECRET = original;
    }
  };

  test("encrypt and decrypt throw when ENCRYPTION_SECRET is missing", () => {
    const ciphertext = encrypt("value");
    withSecret(undefined, () => {
      expect(() => encrypt("value")).toThrow(/ENCRYPTION_SECRET.*required/);
      expect(() => decrypt(ciphertext)).toThrow(/ENCRYPTION_SECRET.*required/);
    });
  });

  test("a secret shorter than 32 characters is rejected", () => {
    withSecret("tooshort", () => {
      expect(() => encrypt("value")).toThrow(
        "ENCRYPTION_SECRET must be at least 32 characters long"
      );
    });
  });

  test("exactly 32 characters is accepted", () => {
    withSecret("a".repeat(32), () => {
      expect(decrypt(encrypt("boundary"))).toBe("boundary");
    });
  });

  test("the original secret is restored for the rest of the suite", () => {
    expect(process.env.ENCRYPTION_SECRET).toBe(TEST_SECRET);
    expect(decrypt(encrypt("still working"))).toBe("still working");
  });
});

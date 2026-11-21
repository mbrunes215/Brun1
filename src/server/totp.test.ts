import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from "./totp";

// RFC 4226 Appendix D / RFC 6238 Appendix B test vectors (secret "12345678901234567890").
const SECRET = Buffer.from("12345678901234567890");
const B32 = base32Encode(SECRET);

describe("TOTP", () => {
  it("round-trips base32", () => {
    expect(base32Decode(B32).toString()).toBe("12345678901234567890");
  });
  it("matches RFC 4226 HOTP vectors", () => {
    expect(["755224", "287082", "359152", "969429"]).toEqual([0, 1, 2, 3].map((c) => hotp(SECRET, c)));
  });
  it("matches RFC 6238 TOTP vectors (last 6 digits)", () => {
    expect(totp(B32, 59_000)).toBe("287082");
    expect(totp(B32, 1111111109_000)).toBe("081804");
    expect(totp(B32, 1234567890_000)).toBe("005924");
  });
  it("accepts one step of drift and rejects garbage", () => {
    expect(verifyTotp(B32, totp(B32, 1234567890_000 - 30_000), 1234567890_000)).toBe(true);
    expect(verifyTotp(B32, totp(B32, 1234567890_000 - 90_000), 1234567890_000)).toBe(false);
    expect(verifyTotp(B32, "abc", 0)).toBe(false);
  });
});

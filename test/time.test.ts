import { describe, expect, it } from "vitest";
import { ageDays, parseSince } from "../src/lib/time.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");

describe("parseSince", () => {
  it("parses relative minutes, hours and days", () => {
    expect(parseSince("30m", NOW).toISOString()).toBe("2026-09-30T23:30:00.000Z");
    expect(parseSince("24h", NOW).toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(parseSince("7d", NOW).toISOString()).toBe("2026-09-24T00:00:00.000Z");
  });

  it("parses ISO 8601 durations", () => {
    expect(parseSince("P1D", NOW).toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(parseSince("P7D", NOW).toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(parseSince("PT24H", NOW).toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });

  it("parses ISO dates as exact instants", () => {
    expect(parseSince("2026-09-01T00:00:00Z", NOW).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parseSince("2026-09-01", NOW).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rejects invalid values", async () => {
    for (const value of ["", "yesterday", "P", "10x"]) {
      await expect(async () => parseSince(value, NOW)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("measures age in days", () => {
    expect(ageDays(new Date("2026-09-30T00:00:00Z"), NOW)).toBe(1);
    expect(ageDays(new Date("2026-06-01T00:00:00Z"), NOW)).toBeGreaterThan(90);
  });
});

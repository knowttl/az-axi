import { describe, expect, it } from "vitest";
import { ageDays, normalizeTimespan, parseSince } from "../src/lib/time.js";

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

describe("normalizeTimespan", () => {
  it("converts relative times and durations to uppercase ISO durations", () => {
    expect(normalizeTimespan("24h", NOW)).toBe("PT24H");
    expect(normalizeTimespan("30m", NOW)).toBe("PT30M");
    expect(normalizeTimespan("7d", NOW)).toBe("P7D");
    expect(normalizeTimespan("p1dt12h", NOW)).toBe("P1DT12H");
  });

  it("turns an ISO date into an interval ending at now", () => {
    expect(normalizeTimespan("2026-09-01T00:00:00Z", NOW)).toBe("2026-09-01T00:00:00.000Z/2026-10-01T00:00:00.000Z");
    expect(normalizeTimespan("2026-09-01", NOW)).toBe("2026-09-01T00:00:00.000Z/2026-10-01T00:00:00.000Z");
  });

  it("normalizes start/end and start/duration intervals", () => {
    expect(normalizeTimespan("2026-09-01/2026-09-02", NOW)).toBe(
      "2026-09-01T00:00:00.000Z/2026-09-02T00:00:00.000Z",
    );
    expect(normalizeTimespan("2026-09-01T00:00:00Z/p1d", NOW)).toBe("2026-09-01T00:00:00.000Z/P1D");
  });

  it("rejects empty, future, reversed and non-duration values without --since hints", () => {
    for (const value of ["", "yesterday", "P0D", "PT", "2999-01-01", "2026-09-02/2026-09-01"]) {
      expect(() => normalizeTimespan(value, NOW)).toThrowError(/timespan/);
      try {
        normalizeTimespan(value, NOW);
      } catch (err) {
        const suggestions = (err as { suggestions?: string[] }).suggestions ?? [];
        expect(`${(err as Error).message}\n${suggestions.join("\n")}`).not.toMatch(/--since/);
        expect((err as { code?: string }).code).toBe("VALIDATION_ERROR");
      }
    }
  });
});

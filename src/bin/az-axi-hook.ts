#!/usr/bin/env node
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { sessionSummary } from "../lib/hook.js";
import { redact } from "../lib/redact.js";

/**
 * Session-start hook entry point. Prints a short local-only TOON summary
 * (profile, scope, write posture, version, one next step) and always exits 0
 * unless argv itself is unusable. No network, no Azure call, no `az`.
 * Installed by `az-axi setup hooks`, which registers this binary (not the
 * network-bound dashboard) with the agent harnesses.
 */
function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    const out: Record<string, unknown> = { error: error.message, code: error.code };
    if (error.suggestions.length > 0) out.help = error.suggestions;
    return { output: `${encode(redact(out))}\n`, exitCode: error.code === "UNKNOWN_FLAG" || error.code === "VALIDATION_ERROR" ? 2 : 1 };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { output: `${encode({ error: message, code: "UNKNOWN" })}\n`, exitCode: 1 };
}

let output: string;
try {
  output = `${encode(redact(sessionSummary(process.argv.slice(2))))}\n`;
} catch (error) {
  const formatted = formatError(error);
  process.stdout.write(formatted.output);
  process.exit(formatted.exitCode);
}
process.stdout.write(output);
process.exit(0);

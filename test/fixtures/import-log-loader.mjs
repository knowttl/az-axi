import { appendFileSync } from "node:fs";

/** Records raw ESM specifiers so tests can assert what the bin (pre)loads. */
export async function resolve(specifier, context, next) {
  try {
    const log = process.env.AZ_AXI_IMPORT_LOG;
    if (log) appendFileSync(log, `${specifier}\n`);
  } catch {
    // Never break the loading under test.
  }
  return next(specifier, context);
}

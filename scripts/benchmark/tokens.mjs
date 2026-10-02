import { countTokens as count } from "gpt-tokenizer/encoding/o200k_base";

/** Counts ordinary benchmark text, including literal special-token spellings. */
export function countTokens(text) {
  return count(text, { disallowedSpecial: new Set() });
}

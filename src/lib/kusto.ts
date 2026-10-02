/**
 * Log Analytics `tables` to objects (PLAN.md Section 6.10).
 * The query API returns `{ tables: [{ name, columns: [{ name, type }], rows }] }`.
 * The primary table becomes an array of objects; any extra tables are counts only.
 */

export interface KustoColumn {
  name: string;
  type: string;
}

export interface KustoTable {
  name: string;
  columns?: Array<{ name?: string; type?: string }>;
  rows?: unknown[][];
}

export interface KustoPartialError {
  code?: string;
  message?: string;
  details?: Array<{ code?: string; message?: string }>;
  innererror?: KustoPartialError;
}

export interface KustoResponse {
  tables?: KustoTable[];
  error?: KustoPartialError;
}

export interface ConvertedKusto {
  rows: Array<Record<string, unknown>>;
  total: number;
  otherTables?: Array<{ name: string; count: number }>;
}

function columnNames(table: KustoTable | undefined): string[] {
  if (!Array.isArray(table?.columns)) return [];
  return table.columns.map((col) => col?.name ?? "");
}

function rowCount(table: KustoTable | undefined): number {
  return Array.isArray(table?.rows) ? table.rows.length : 0;
}

/** Converts `tables[0]` to objects. Extra tables become name plus row count only. */
export function convertKustoTables(tables: KustoTable[] | undefined, limit?: number): ConvertedKusto {
  if (!Array.isArray(tables) || tables.length === 0) return { rows: [], total: 0 };
  const [primary, ...rest] = tables;
  const columns = columnNames(primary);
  const rawRows = Array.isArray(primary?.rows) ? primary.rows : [];
  const rows = rawRows.slice(0, limit).map((cells) => {
    const out: Record<string, unknown> = {};
    const values = Array.isArray(cells) ? cells : [];
    for (let i = 0; i < columns.length; i++) {
      const key = columns[i] ?? `col${i}`;
      if (!key) continue;
      out[key] = values[i] ?? "";
    }
    return out;
  });
  const otherTables =
    rest.length > 0 ? rest.map((table) => ({ name: table?.name ?? "", count: rowCount(table) })) : undefined;
  return { rows, total: rawRows.length, ...(otherTables ? { otherTables } : {}) };
}

function errorText(error: { code?: string; message?: string } | undefined, labeled: boolean): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const message = (error.message ?? "").trim();
  const code = (error.code ?? "").trim();
  if (labeled) {
    if (message && code) return `Log Analytics reported a partial error (${code}): ${message}`;
    if (message) return `Log Analytics reported a partial error: ${message}`;
    if (code) return `Log Analytics reported a partial error (${code})`;
    return undefined;
  }
  if (message && code) return `${code}: ${message}`;
  return message || code || undefined;
}

function deepestInnerMessage(error: KustoPartialError | undefined): string | undefined {
  let current = error;
  let message: string | undefined;
  const seen = new Set<KustoPartialError>();
  while (current?.innererror && typeof current.innererror === "object" && !seen.has(current)) {
    seen.add(current);
    current = current.innererror;
    const next = (current.message ?? "").trim();
    if (next) message = next;
  }
  return message;
}

/**
 * Human text for an HTTP 200 partial `error` object; empty when there is none.
 * The useful text is often in `details` or `innererror`, not the outer message.
 */
export function partialErrorText(error: KustoPartialError | undefined): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const head = errorText(error, true) ?? "Log Analytics reported a partial error";
  const extras: string[] = [];
  const details = Array.isArray(error.details) ? error.details.slice(0, 3) : [];
  for (const detail of details) {
    const text = errorText(detail, false);
    if (text) extras.push(text);
  }
  const inner = deepestInnerMessage(error);
  if (inner && inner !== (error.message ?? "").trim()) extras.push(inner);
  const joined = extras.length > 0 ? `${head}; ${extras.join("; ")}` : head;
  return joined.length > 500 ? `${joined.slice(0, 500)}...` : joined;
}

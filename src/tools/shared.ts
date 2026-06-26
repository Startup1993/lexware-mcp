import type { Paged } from "../lexware/types.js";

/** Default page size for list tools. */
export const DEFAULT_PAGE_SIZE = 25;

/** Tool annotations, shared so semantics can't drift across tool files. */
export const RO = { readOnlyHint: true, openWorldHint: true, destructiveHint: false } as const;
export const WRITE = { readOnlyHint: false, openWorldHint: true, destructiveHint: false } as const;
export const DESTRUCTIVE = { readOnlyHint: false, openWorldHint: true, destructiveHint: true } as const;
/** Read-only and purely local (no external reach), e.g. building a deeplink string. */
export const LOCAL_RO = { readOnlyHint: true, openWorldHint: false, destructiveHint: false } as const;

/** Wrap a string as MCP text content. */
export function text(message: string): [{ type: "text"; text: string }] {
  return [{ type: "text", text: message }];
}

/** Cap on inlined list JSON (chars). Above this, each entry is projected to identifiers. */
const MAX_INLINE_CHARS = 12_000;

/**
 * Identifying fields kept when a list is too large to inline in full. `id` is
 * always emitted separately, so a client can always follow up with a get-* call.
 */
const COMPACT_KEYS = [
  "name",
  "companyName",
  "title",
  "number",
  "articleNumber",
  "voucherNumber",
  "voucherType",
  "voucherStatus",
  "voucherDate",
  "contactName",
  "totalAmount",
  "openAmount",
  "currency",
] as const;

/** Project one entry down to its id plus a few identifying fields. */
function compactEntry(entry: unknown): unknown {
  if (!isPlainObject(entry)) return entry;
  const out: Record<string, unknown> = {};
  if ("id" in entry) out.id = entry.id;
  for (const key of COMPACT_KEYS) if (key in entry) out[key] = entry[key];
  return Object.keys(out).length ? out : entry;
}

/**
 * Serialize a list payload for the TEXT channel so IDs/names/fields actually
 * reach clients that ignore `structuredContent`. Returns the full value as
 * pretty JSON, or — when that would blow the token budget and the value is an
 * array — a per-entry projection to identifiers (id always kept) plus a note so
 * the model knows to drill into a get-* tool for full detail.
 */
export function inlineList(items: unknown): string {
  const full = JSON.stringify(items, null, 2) ?? "null";
  if (full.length <= MAX_INLINE_CHARS || !Array.isArray(items)) return full;
  return (
    JSON.stringify(items.map(compactEntry), null, 2) +
    "\n\n(Large result: fields reduced to identifiers. Use the matching get-* tool with an id for the full record.)"
  );
}

/** Standard result for a paged list tool: the Paged envelope + summary + inlined rows. */
export function pagedResult<T>(result: Paged<T>, noun: string) {
  const header =
    `Found ${result.totalElements} ${noun}; showing page ${result.number + 1}/${result.totalPages} ` +
    `(${result.numberOfElements} on this page).`;
  return {
    structuredContent: result,
    content: text(`${header}\n\n${inlineList(result.content)}`),
  };
}

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read-modify-write merge: overlay `patch` onto `base`, recursing into nested
 * objects so a partial sub-object (e.g. `{ company: { vatRegistrationId } }`)
 * updates one field without wiping its siblings (`company.name`). Arrays and
 * scalars replace wholesale; an `undefined` patch value leaves the base untouched
 * (callers preserve a field by simply omitting it); an explicit `null` clears it.
 *
 * Lexware/lexoffice `PUT` replaces the WHOLE resource, so update tools must GET the
 * current object and merge the caller's fields over it — otherwise omitted fields
 * (attached files, addresses, voucherNumber, …) would be silently wiped and
 * required fields would 406.
 */
export function deepMergePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] =
      isPlainObject(value) && isPlainObject(existing) ? deepMergePatch(existing, value) : value;
  }
  return out;
}

/**
 * Merge a contact's address collection (`{ billing: [...], shipping: [...] }`) by
 * INDEX, deep-merging each address object — unlike {@link deepMergePatch}, which
 * replaces arrays wholesale. This lets a partial patch (e.g. just `countryCode`)
 * update the matching existing address instead of wiping its street/zip/city.
 * lexoffice requires `countryCode` in every address object, so element-wise merge
 * keeps the existing address valid. Existing entries the patch doesn't reach are
 * preserved.
 */
export function mergeAddresses(current: unknown, patch: unknown): Record<string, unknown> {
  const cur = isPlainObject(current) ? current : {};
  const pat = isPlainObject(patch) ? patch : {};
  const out: Record<string, unknown> = { ...cur };
  for (const [key, value] of Object.entries(pat)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const base = Array.isArray(cur[key]) ? (cur[key] as unknown[]) : [];
      const merged = value.map((entry, i) =>
        isPlainObject(entry) && isPlainObject(base[i]) ? deepMergePatch(base[i], entry) : entry,
      );
      // Keep existing addresses beyond the patch length (e.g. a second billing address).
      out[key] = base.length > value.length ? merged.concat(base.slice(value.length)) : merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}

import { createHash, randomUUID } from 'node:crypto';

/** Random id for rows we create ourselves. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * Deterministic id derived from natural keys. Used wherever re-ingesting the
 * same material must land on the same row rather than duplicating it - which is
 * every source, since feeds re-serve their whole window on every poll.
 */
export function stableId(prefix: string, ...parts: (string | number | null | undefined)[]): string {
  const h = createHash('sha256').update(parts.map((p) => String(p ?? '')).join(' ')).digest('hex');
  return `${prefix}_${h.slice(0, 20)}`;
}

/**
 * Matching key for entity names. Strips case, punctuation, diacritics and the
 * corporate suffixes that make "Lockheed Martin Corp." and "Lockheed Martin"
 * look like different companies.
 */
export function slugifyEntity(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(
      /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|lp|llp|plc|nv|sa|ag|gmbh|holdings|holding|group|the)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

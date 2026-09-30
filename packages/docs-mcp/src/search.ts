export interface Doc {
  id: string;
  locale: string;
  title: string;
  url: string;
  md_url?: string;
  headings: string[];
  text: string;
}

export interface SearchHit {
  id: string;
  locale: string;
  title: string;
  url: string;
  md_url?: string;
  score: number;
  snippet: string;
}

export interface SearchOptions {
  query: string;
  locale?: string;
  limit?: number;
}

const SNIPPET = 160;

export const tokenize = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function search(docs: readonly Doc[], {query, locale, limit = 10}: SearchOptions): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    if (locale && doc.locale !== locale) continue;
    const title = new Set(tokenize(doc.title));
    const headings = new Set(tokenize(doc.headings.join(' ')));
    const text = new Set(tokenize(doc.text));
    let score = 0;
    for (const t of terms) score += (title.has(t) ? 3 : 0) + (headings.has(t) ? 2 : 0) + (text.has(t) ? 1 : 0);
    if (score === 0) continue;
    hits.push({id: doc.id, locale: doc.locale, title: doc.title, url: doc.url, md_url: doc.md_url, score, snippet: snippet(doc.text, terms)});
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function snippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let at = 0;
  for (const t of [...terms].sort((a, b) => b.length - a.length)) {
    const i = lower.indexOf(t);
    if (i !== -1) { at = i; break; }
  }
  const start = Math.max(0, Math.min(at - 40, flat.length - SNIPPET));
  const cutLeft = start > 0, cutRight = start + SNIPPET < flat.length;
  // a window edge can split a surrogate pair; drop the orphan half
  const body = flat.slice(start, start + SNIPPET - (cutLeft ? 1 : 0) - (cutRight ? 1 : 0)).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '');
  return (cutLeft ? '…' : '') + body + (cutRight ? '…' : '');
}

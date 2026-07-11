import { query } from "./db";
import { embedQuery, toVectorLiteral } from "./embed";
import { generate } from "./llm";

export type Source = {
  city: string;
  citation: string | null;
  heading: string | null;
  sectionPath: string | null;
  snippet: string;
  score: number;
};

// Turn a natural-language question into an OR full-text query. websearch_to_
// tsquery is robust to stopwords/punctuation; "or" gives recall (rank still
// rewards chunks that match more terms).
function toSearchText(q: string): string {
  const words = q.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  return words.join(" or ");
}

// "5.06.030" -> "5.06", "17.84.110" -> "17.84", "Chapter 1.04" -> "1.04"
function chapterPrefix(citation: string | null): string | null {
  const m = citation?.match(/(\d+\.\d+)/);
  return m ? m[1] : null;
}

type Row = {
  id: number;
  city_slug: string;
  city: string;
  citation: string | null;
  heading: string | null;
  section_path: string | null;
  content: string;
  score: number;
};

const toSource = (r: Row): Source => ({
  city: r.city,
  citation: r.citation,
  heading: r.heading,
  sectionPath: r.section_path,
  snippet: r.content,
  score: Number(r.score),
});

/**
 * Hybrid retrieval with chapter expansion.
 *
 * 1. Fuse dense vector search + full-text keyword search via Reciprocal Rank
 *    Fusion (RRF) — avoids normalizing the two score scales.
 * 2. Municipal codes spread an answer across sibling sections of a chapter
 *    (e.g. the "business license tax" = §5.06.030 + §5.06.050, defined by
 *    §5.06.020). So for the top hits we pull in ALL sibling sections of their
 *    chapter, scoped to the same city.
 */
export async function retrieve(
  question: string,
  opts: { city?: string; k?: number } = {}
): Promise<Source[]> {
  const k = opts.k ?? 8;
  const vec = toVectorLiteral(await embedQuery(question));
  const tsText = toSearchText(question);

  const params: any[] = [vec, tsText];
  let cityFilter = "";
  if (opts.city) {
    params.push(opts.city);
    cityFilter = `AND c.city_slug = $${params.length}`;
  }
  params.push(k);
  const limitParam = `$${params.length}`;

  const ranked: Row[] = await query(
    `WITH vec AS (
       SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $1::vector) AS rnk
       FROM chunks c
       WHERE true ${cityFilter}
       ORDER BY c.embedding <=> $1::vector
       LIMIT 40
     ),
     fts AS (
       SELECT c.id, row_number() OVER (ORDER BY ts_rank(c.tsv, q) DESC) AS rnk
       FROM chunks c, websearch_to_tsquery('english', $2) q
       WHERE c.tsv @@ q ${cityFilter}
       ORDER BY ts_rank(c.tsv, q) DESC
       LIMIT 40
     ),
     fused AS (
       SELECT COALESCE(v.id, f.id) AS id,
              COALESCE(1.0 / (60 + v.rnk), 0) + COALESCE(1.0 / (60 + f.rnk), 0) AS rrf
       FROM vec v FULL OUTER JOIN fts f ON v.id = f.id
     )
     SELECT c.id, c.city_slug, ct.name AS city, c.citation, c.heading,
            c.section_path, c.content, 1 - (c.embedding <=> $1::vector) AS score
     FROM fused
     JOIN chunks c ON c.id = fused.id
     JOIN cities ct ON ct.slug = c.city_slug
     ORDER BY fused.rrf DESC
     LIMIT ${limitParam}`,
    params
  );

  // Chapter expansion for the strongest hits. Take the chapters of the top few
  // distinct hits and pull ALL their sibling sections, then merge round-robin
  // so each relevant chapter contributes evenly (one big chapter can't starve
  // the rest).
  const EXPAND_CHAPTERS = 3;
  const MAX_EXTRA = 16;
  const seedPairs: { slug: string; pref: string }[] = [];
  const seen = new Set<string>();
  for (const r of ranked) {
    const pref = chapterPrefix(r.citation);
    const key = `${r.city_slug}|${pref}`;
    if (pref && !seen.has(key)) {
      seen.add(key);
      seedPairs.push({ slug: r.city_slug, pref });
      if (seedPairs.length >= EXPAND_CHAPTERS) break;
    }
  }

  const rankedIds = new Set(ranked.map((r) => r.id));
  const extras: Row[] = [];
  if (seedPairs.length) {
    const sp: any[] = [vec];
    const conds = seedPairs
      .map((pr) => {
        sp.push(pr.slug, `${pr.pref}.`);
        return `(c.city_slug = $${sp.length - 1} AND c.citation LIKE $${sp.length} || '%')`;
      })
      .join(" OR ");
    const siblings: Row[] = await query(
      `SELECT c.id, c.city_slug, ct.name AS city, c.citation, c.heading,
              c.section_path, c.content, 1 - (c.embedding <=> $1::vector) AS score
       FROM chunks c JOIN cities ct ON ct.slug = c.city_slug
       WHERE (${conds})
       ORDER BY c.city_slug, c.citation
       LIMIT 120`,
      sp
    );
    const groups: Row[][] = seedPairs.map(() => []);
    const gi = new Map(seedPairs.map((p, i) => [`${p.slug}|${p.pref}`, i]));
    // dedupe by citation (some sections are split across multiple chunks)
    const seenCite = new Set(ranked.map((r) => `${r.city_slug}|${r.citation}`));
    for (const s of siblings) {
      if (rankedIds.has(s.id)) continue;
      const citeKey = `${s.city_slug}|${s.citation}`;
      if (s.citation && seenCite.has(citeKey)) continue;
      seenCite.add(citeKey);
      const i = gi.get(`${s.city_slug}|${chapterPrefix(s.citation)}`);
      if (i !== undefined) groups[i].push(s);
    }
    for (let col = 0; extras.length < MAX_EXTRA; col++) {
      let any = false;
      for (const g of groups) {
        if (g[col] && extras.length < MAX_EXTRA) {
          extras.push(g[col]);
          any = true;
        }
      }
      if (!any) break;
    }
  }

  // RRF-ranked hits first, then the round-robin chapter sections.
  return [...ranked, ...extras].map(toSource);
}

const SYSTEM = `You are a careful legal-research assistant answering questions about California municipal codes.
Rules:
- Answer ONLY using the provided context excerpts. Do not use outside knowledge.
- Cite the specific section number(s) you rely on, e.g. "(§ 5.06.030)".
- If the context does not contain the answer, say so plainly and suggest checking the city's official code site. Do not guess.
- Be concise and factual. Quote exact figures/dates when relevant.
- End with one short line: "Not legal advice — verify against the official code."`;

export async function answer(
  question: string,
  opts: { city?: string } = {}
): Promise<{ answer: string; sources: Source[] }> {
  const sources = await retrieve(question, { city: opts.city });
  if (sources.length === 0) {
    return {
      answer:
        "I couldn't find anything in the indexed codes for that. Try rephrasing, or check the city's official code site.",
      sources: [],
    };
  }
  const context = sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.city} — ${s.citation ?? s.heading ?? "section"}${
          s.sectionPath ? ` (${s.sectionPath})` : ""
        }\n${s.snippet}`
    )
    .join("\n\n---\n\n");
  const user = `Context excerpts from the municipal code(s):\n\n${context}\n\nQuestion: ${question}`;
  const text = await generate(SYSTEM, user);
  return { answer: text.trim(), sources };
}

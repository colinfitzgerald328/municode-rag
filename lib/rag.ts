import { query, queryHnsw } from "./db";
import { embedQuery, toVectorLiteral } from "./embed";
import { generate } from "./llm";

export type Source = {
  city: string;
  citation: string | null;
  chapter: string | null;
  chapterName: string | null;
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

// Auto-detect which jurisdiction a question is about by matching city names
// (cached from the DB). Returns the slug, or null if none/ambiguous.
let cityCache: { slug: string; name: string }[] | null = null;
export async function detectCity(question: string): Promise<string | null> {
  if (!cityCache) {
    cityCache = await query<{ slug: string; name: string }>(
      `SELECT slug, name FROM cities`
    );
  }
  const q = question.toLowerCase();
  const hits = cityCache.filter((c) => {
    const name = c.name.toLowerCase();
    const slugSpaced = c.slug.replace(/-/g, " ");
    return q.includes(name) || q.includes(slugSpaced);
  });
  // Only auto-scope when exactly one city is named (don't guess if ambiguous).
  return hits.length === 1 ? hits[0].slug : null;
}

type Row = {
  id: number;
  city_slug: string;
  city: string;
  citation: string | null;
  chapter: string | null;
  chapter_name: string | null;
  heading: string | null;
  section_path: string | null;
  content: string;
  score: number;
};

const toSource = (r: Row): Source => ({
  city: r.city,
  citation: r.citation,
  chapter: r.chapter,
  chapterName: r.chapter_name,
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
  const k = opts.k ?? 10;
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

  const ranked: Row[] = await queryHnsw(
    `WITH vec AS (
       SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $1::vector) AS rnk
       FROM chunks c
       WHERE true ${cityFilter}
       ORDER BY c.embedding <=> $1::vector
       LIMIT 100
     ),
     fts AS (
       SELECT c.id, row_number() OVER (ORDER BY ts_rank(c.tsv, q) DESC) AS rnk
       FROM chunks c, websearch_to_tsquery('english', $2) q
       WHERE c.tsv @@ q ${cityFilter}
       ORDER BY ts_rank(c.tsv, q) DESC
       LIMIT 80
     ),
     fused AS (
       SELECT COALESCE(v.id, f.id) AS id,
              COALESCE(1.0 / (60 + v.rnk), 0) + COALESCE(1.0 / (60 + f.rnk), 0) AS rrf
       FROM vec v FULL OUTER JOIN fts f ON v.id = f.id
     )
     SELECT c.id, c.city_slug, ct.name AS city, c.citation, c.chapter,
            c.chapter_name, c.heading, c.section_path, c.content,
            1 - (c.embedding <=> $1::vector) AS score
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
  const EXPAND_CHAPTERS = 4;
  const MAX_EXTRA = 28;
  const seedPairs: { slug: string; pref: string }[] = [];
  const seen = new Set<string>();
  for (const r of ranked) {
    const pref = r.chapter ?? chapterPrefix(r.citation);
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
        sp.push(pr.slug, pr.pref);
        return `(c.city_slug = $${sp.length - 1} AND c.chapter = $${sp.length})`;
      })
      .join(" OR ");
    const siblings: Row[] = await query(
      `SELECT c.id, c.city_slug, ct.name AS city, c.citation, c.chapter,
              c.chapter_name, c.heading, c.section_path, c.content,
              1 - (c.embedding <=> $1::vector) AS score
       FROM chunks c JOIN cities ct ON ct.slug = c.city_slug
       WHERE (${conds})
         AND c.citation IS DISTINCT FROM c.chapter   -- skip the chapter-node TOC chunk
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
      const i = gi.get(`${s.city_slug}|${s.chapter ?? chapterPrefix(s.citation)}`);
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

Municipal codes are hierarchical: Title → Chapter → Section. The context is grouped by chapter; the numbered items under each chapter heading are its sibling sections (e.g. § 5.06.030). A complete answer often spans several sections of the same chapter — read them together.

Rules:
- Answer ONLY using the provided context excerpts. Do not use outside knowledge.
- Cite every section you rely on, e.g. "(§ 5.06.030)". When helpful, name the chapter it belongs to.
- Format the answer in Markdown: short paragraphs, **bold** for key figures/terms, and bulleted or numbered lists for rates, fees, requirements, or multi-part rules.
- Quote exact figures, rates, and dates verbatim.
- If the context does not contain the answer, say so plainly and suggest checking the city's official code site. Do not guess.
- End with one short line: "Not legal advice — verify against the official code."`;

export async function answer(
  question: string,
  opts: { city?: string } = {}
): Promise<{ answer: string; sources: Source[]; city: string | null; autoCity: boolean }> {
  // Respect an explicit city; otherwise try to infer it from the question.
  const detected = opts.city ? null : await detectCity(question);
  const city = opts.city || detected || undefined;
  const sources = await retrieve(question, { city });
  if (sources.length === 0) {
    return {
      answer:
        "Nothing in these codes matched that. Try rephrasing your question, or check the city's official code site.",
      sources: [],
      city: city ?? null,
      autoCity: !!detected,
    };
  }
  // Group retrieved sections under their City › Chapter so the model sees the
  // Title → Chapter → Section hierarchy, preserving retrieval order of chapters.
  const order: string[] = [];
  const groups = new Map<string, Source[]>();
  for (const s of sources) {
    const key = `${s.city}|||${s.chapter ?? ""}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(s);
  }
  let n = 0;
  const context = order
    .map((key) => {
      const items = groups.get(key)!;
      const { city, chapter, chapterName } = items[0];
      const head = chapter
        ? `${city} — Chapter ${chapter}${chapterName ? `: ${chapterName}` : ""}`
        : city;
      const body = items
        .map((s) => {
          n += 1;
          const label = s.citation ? `§ ${s.citation}` : s.heading ?? "section";
          const name =
            s.heading && s.citation
              ? s.heading.replace(s.citation, "").replace(/^[\s.\-–—]+/, "").trim()
              : "";
          return `[${n}] ${label}${name ? ` — ${name}` : ""}\n${s.snippet}`;
        })
        .join("\n\n");
      return `### ${head}\n${body}`;
    })
    .join("\n\n");
  const user = `Context excerpts from the municipal code(s), grouped by chapter:\n\n${context}\n\nQuestion: ${question}`;
  const text = await generate(SYSTEM, user);
  return { answer: text.trim(), sources, city: city ?? null, autoCity: !!detected };
}

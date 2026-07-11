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

/** Vector search over the chunks table (optionally scoped to one city). */
export async function retrieve(
  question: string,
  opts: { city?: string; k?: number } = {}
): Promise<Source[]> {
  const k = opts.k ?? 8;
  const vec = toVectorLiteral(await embedQuery(question));
  const params: any[] = [vec];
  let where = "";
  if (opts.city) {
    params.push(opts.city);
    where = `WHERE c.city_slug = $${params.length}`;
  }
  params.push(k);
  const rows = await query(
    `SELECT ct.name AS city, c.citation, c.heading, c.section_path, c.content,
            1 - (c.embedding <=> $1::vector) AS score
     FROM chunks c
     JOIN cities ct ON ct.slug = c.city_slug
     ${where}
     ORDER BY c.embedding <=> $1::vector
     LIMIT $${params.length}`,
    params
  );
  return rows.map((r: any) => ({
    city: r.city,
    citation: r.citation,
    heading: r.heading,
    sectionPath: r.section_path,
    snippet: r.content,
    score: Number(r.score),
  }));
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
  const sources = await retrieve(question, { city: opts.city, k: 8 });
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

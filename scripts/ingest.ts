// One-time (idempotent) ingest: parse each city's Markdown code into chunks,
// embed them locally with fastembed, and upsert into Neon (pgvector).
//
//   npm run ingest            # all cities
//   npm run ingest -- benicia # a single city
//
// Re-running replaces a city's chunks, so it's safe to run repeatedly.
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../lib/db";
import { chunkMarkdown } from "../lib/chunk";
import { embedDocuments, toVectorLiteral } from "../lib/embed";

const DATA_DIR = join(process.cwd(), "data");
const WINDOW = 256; // chunks embedded + inserted per pass

// Never let a dropped idle connection crash the process.
pool.on("error", (e) => console.error("  [pg pool warning]", e.message));

function fileToSlug(file: string): string {
  return file.replace(/-\d{4}-\d{2}-\d{2}\.md$/, "").replace(/_/g, "-");
}

function titleCase(slug: string): string {
  return slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

async function insertRows(
  slug: string,
  rows: { ord: number; citation: string | null; heading: string | null; path: string | null; content: string; vec: number[] }[]
) {
  const values: any[] = [];
  const tuples: string[] = [];
  rows.forEach((r, j) => {
    const b = j * 7;
    tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::vector)`);
    values.push(slug, r.ord, r.citation, r.heading, r.path, r.content, toVectorLiteral(r.vec));
  });
  await pool.query(
    `INSERT INTO chunks (city_slug, ord, citation, heading, section_path, content, embedding)
     VALUES ${tuples.join(",")}`,
    values
  );
}

async function ingestCity(file: string) {
  const slug = fileToSlug(file);
  const chunks = chunkMarkdown(readFileSync(join(DATA_DIR, file), "utf8"));
  console.log(`\n${slug}: ${chunks.length} chunks`);

  await pool.query(
    `INSERT INTO cities (slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO NOTHING`,
    [slug, titleCase(slug)]
  );
  await pool.query(`DELETE FROM chunks WHERE city_slug = $1`, [slug]);

  const t0 = Date.now();
  for (let i = 0; i < chunks.length; i += WINDOW) {
    const win = chunks.slice(i, i + WINDOW);
    const vecs = await embedDocuments(win.map((c) => c.content));
    await insertRows(
      slug,
      win.map((c, j) => ({
        ord: i + j,
        citation: c.citation,
        heading: c.heading || null,
        path: c.sectionPath || null,
        content: c.content,
        vec: vecs[j],
      }))
    );
    process.stdout.write(`\r  ${Math.min(i + WINDOW, chunks.length)}/${chunks.length}`);
  }
  await pool.query(`UPDATE chunks SET char_len = length(content) WHERE city_slug = $1`, [slug]);
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Derive the Title → Chapter → Section hierarchy fields the app reasons over:
//   chapter       — the chapter number, from the section citation (5.06.030 -> 5.06)
//   chapter_name  — the chapter's title, taken from its chapter-node heading/content
async function backfillHierarchy() {
  await pool.query(
    `UPDATE chunks SET chapter = substring(citation from '^\\d+\\.\\d+')
     WHERE citation ~ '^\\d+\\.\\d+' AND chapter IS DISTINCT FROM substring(citation from '^\\d+\\.\\d+')`
  );
  // Chapter name from the chapter-node heading ("Chapter 3.04 - GENERAL PROVISIONS"),
  // falling back to the second content line (Municode puts the name there).
  await pool.query(
    `WITH chap AS (
       SELECT city_slug,
              substring(citation from '^\\d+\\.\\d+') AS chapter,
              COALESCE(
                NULLIF(trim(regexp_replace(heading, '^Chapter\\s+[\\d.]+\\s*[-–—:]?\\s*', '', 'i')), ''),
                NULLIF(regexp_replace((regexp_split_to_array(content, E'\\n'))[2], '\\s*\\d+\\s*$', ''), '')
              ) AS cname
       FROM chunks
       WHERE heading ~* '^Chapter\\s' AND citation ~ '^\\d+\\.\\d+$'
     )
     UPDATE chunks c
     SET chapter_name = initcap(chap.cname)
     FROM chap
     WHERE c.city_slug = chap.city_slug AND c.chapter = chap.chapter
       AND chap.cname IS NOT NULL AND chap.cname !~* '^section'
       AND length(chap.cname) BETWEEN 3 AND 120`
  );
}

async function main() {
  const only = process.argv[2];
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".md"));
  const targets = only ? files.filter((f) => fileToSlug(f) === only) : files;
  if (targets.length === 0) {
    console.error(`No data files match ${only ?? "*.md"} in ${DATA_DIR}`);
    process.exit(1);
  }
  for (const f of targets) await ingestCity(f);
  await backfillHierarchy();

  const { rows } = await pool.query(
    `SELECT city_slug, count(*)::int AS n FROM chunks GROUP BY city_slug ORDER BY city_slug`
  );
  console.log("\nchunk counts:", rows);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

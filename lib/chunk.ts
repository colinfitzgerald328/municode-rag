// Turn a fetched municipal-code Markdown file into retrieval chunks.
//
// The three source platforms format headings differently:
//   * Municode:       `## 3.04.010 - Definitions.`  (one heading per section)
//   * codepublishing: `## Chapter 1.04`             (one heading per chapter)
//   * eCode360:       `# Title 1` + `## Chapter 1.01` (section text is inline)
// We split on `##` headings, carry the enclosing `# Title` as context, and
// sub-split any oversized body on paragraph boundaries.

export type Chunk = {
  citation: string | null;
  heading: string;
  sectionPath: string;
  content: string;
};

const MAX = 1800; // target chars per chunk
const MIN = 40; // discard near-empty fragments

function extractCitation(heading: string): string | null {
  // Municode Title-Chapter.Section style, e.g. "16-40.042", "16-100.020",
  // "20-5.5", "13A-6" (Tiburon). Checked first so the title prefix is kept.
  const hyphen = heading.match(/\b(\d+[A-Z]?-\d+(?:\.\d+)*)\b/);
  if (hyphen) return hyphen[1];
  const dotted = heading.match(/\b(\d+\.\d+(?:\.\d+)?)\b/);
  if (dotted) return dotted[1];
  const named = heading.match(/\b((?:Chapter|Title|Article|Division|Appendix)\s+[\w.]+)/i);
  return named ? named[1] : null;
}

function splitLong(text: string): string[] {
  if (text.length <= MAX) return [text];
  const out: string[] = [];
  let buf = "";
  for (const para of text.split(/\n\s*\n/)) {
    if (buf && (buf.length + para.length + 2) > MAX) {
      out.push(buf);
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    while (buf.length > MAX * 1.6) {
      out.push(buf.slice(0, MAX));
      buf = buf.slice(MAX);
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// eCode360 (Menlo Park) doesn't emit `##` section headings — it inlines each
// section as a bare "§ 1.01.020" marker line, followed by the section title,
// then the body. Split on those markers so every section gets its own chunk
// and citation instead of being chopped into citation-less blobs by size.
function chunkEcode360(md: string): Chunk[] {
  const chunks: Chunk[] = [];
  let title = "";
  let cur: { citation: string; titleLine: string; body: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").trim();
    // A section with no body is a table-of-contents stub — its real copy repeats
    // later with the same citation, so dropping the stub de-dupes naturally.
    if (body.length >= MIN) {
      const heading = cur.titleLine
        ? `${cur.citation} ${cur.titleLine}`
        : cur.citation;
      const path = [title, heading].filter(Boolean).join(" › ");
      for (const piece of splitLong(body)) {
        chunks.push({ heading, citation: cur.citation, sectionPath: path, content: `${heading}\n${piece}` });
      }
    }
    cur = null;
  };

  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^#\s+/.test(line)) {
      flush();
      title = line.replace(/^#\s+/, "").trim();
      continue;
    }
    const m = line.match(/^§\s+([0-9A-Za-z][0-9A-Za-z.\-]*)\s*$/);
    if (m) {
      flush();
      cur = { citation: m[1], titleLine: "", body: [] };
      continue;
    }
    if (/^##\s+/.test(line) || /^-{3,}\s*$/.test(line)) continue;
    if (!cur) continue; // skip chapter-list preamble before the first section
    if (!cur.titleLine && line.trim()) cur.titleLine = line.trim();
    else cur.body.push(line);
  }
  flush();
  return chunks.filter((c) => c.content.trim().length >= MIN);
}

export function chunkMarkdown(md: string): Chunk[] {
  // Route the eCode360 flat format (many bare "§ x.xx.xxx" markers) to its own
  // section-aware splitter; everything else uses the heading-based splitter.
  if ((md.match(/^§\s+[0-9]/gm) || []).length > 100) return chunkEcode360(md);

  const chunks: Chunk[] = [];
  let title = "";
  let cur: { heading: string; body: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").trim();
    const heading = cur.heading;
    if (body.length >= MIN || (heading && body.length > 0)) {
      const path = [title, heading].filter(Boolean).join(" › ");
      for (const piece of splitLong(body)) {
        chunks.push({
          heading,
          citation: extractCitation(heading || title),
          sectionPath: path,
          content: (heading ? `${heading}\n` : "") + piece,
        });
      }
    }
    cur = null;
  };

  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^#\s+/.test(line)) {
      flush();
      title = line.replace(/^#\s+/, "").trim();
      continue;
    }
    if (/^##\s+/.test(line)) {
      flush();
      cur = { heading: line.replace(/^##\s+/, "").trim(), body: [] };
      continue;
    }
    if (/^-{3,}\s*$/.test(line)) {
      flush();
      continue;
    }
    if (!cur) cur = { heading: "", body: [] };
    cur.body.push(line);
  }
  flush();

  return chunks.filter((c) => c.content.trim().length >= MIN);
}

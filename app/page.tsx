"use client";

import { useEffect, useRef, useState } from "react";

type City = {
  slug: string;
  name: string;
  source_url: string | null;
  fetched_on: string | null;
  chunks: number;
};
type Source = {
  city: string;
  citation: string | null;
  chapter?: string | null;
  chapterName?: string | null;
  heading: string | null;
  sectionPath: string | null;
  snippet: string;
  score: number;
};
type Answer = {
  answer: string;
  sources: Source[];
  city?: string | null;
  autoCity?: boolean;
};

const SUGGESTIONS = [
  "What is the business license tax in Benicia?",
  "Are short-term rentals allowed in Tiburon?",
  "What are the noise ordinance rules in Menlo Park?",
  "Do I need a permit to keep chickens in Redding?",
];

// Highlight section citations (§ 5.06.030, Chapter 1.04) within a text run.
function citeSpans(text: string, key: string): React.ReactNode[] {
  return text.split(/(§\s?\d[\d.\-]*|Chapter\s+[\d.]+)/g).map((p, i) =>
    /^(§|Chapter)/.test(p) ? (
      <span className="cite" key={`${key}-${i}`}>
        {p}
      </span>
    ) : (
      <span key={`${key}-${i}`}>{p}</span>
    )
  );
}

// Inline Markdown: **bold**, *italic*, plus citation highlighting.
function renderInline(text: string, key: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(...citeSpans(text.slice(last, m.index), `${key}-${n++}`));
    if (m[1] !== undefined)
      nodes.push(<strong key={`${key}-${n++}`}>{citeSpans(m[1], `${key}-s${n}`)}</strong>);
    else if (m[2] !== undefined)
      nodes.push(<em key={`${key}-${n++}`}>{citeSpans(m[2], `${key}-e${n}`)}</em>);
    else nodes.push(<code key={`${key}-${n++}`}>{m[3]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(...citeSpans(text.slice(last), `${key}-${n++}`));
  return nodes;
}

const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/;

// Minimal block-level Markdown → JSX (headings, lists, paragraphs).
function renderMarkdown(md: string): React.ReactNode[] {
  const lines = md.replace(/\r/g, "").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const Tag = (`h${Math.min(h[1].length + 2, 6)}` as unknown) as keyof React.JSX.IntrinsicElements;
      out.push(<Tag key={`b${k++}`}>{renderInline(h[2], `h${k}`)}</Tag>);
      i++;
      continue;
    }
    if (LIST_RE.test(lines[i])) {
      const ordered = /^\s*\d+[.)]/.test(lines[i]);
      const items: string[] = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        items.push(lines[i].replace(LIST_RE, ""));
        i++;
      }
      const kids = items.map((it, j) => <li key={j}>{renderInline(it, `li${k}-${j}`)}</li>);
      out.push(ordered ? <ol key={`b${k++}`}>{kids}</ol> : <ul key={`b${k++}`}>{kids}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(<p key={`b${k++}`}>{renderInline(para.join(" "), `p${k}`)}</p>);
  }
  return out;
}

export default function Home() {
  const [cities, setCities] = useState<City[]>([]);
  const [city, setCity] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Answer | null>(null);
  const [error, setError] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/cities")
      .then((r) => r.json())
      .then((d) => setCities(d.cities ?? []))
      .catch(() => {});
  }, []);

  async function ask(question: string) {
    const text = question.trim();
    if (text.length < 3 || loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, city: city || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Request failed");
      setResult(d);
    } catch (e: any) {
      setError(e.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    ask(q);
  }

  // split answer body (Markdown) from the trailing disclaimer line
  const raw = result?.answer.trim() ?? "";
  const dm = raw.match(/\n*\s*[*_>#\s]*not legal advice[^\n]*\s*$/i);
  const disclaimer = dm ? dm[0].replace(/^[\s*_>#]+/, "").trim() : null;
  const body = dm ? raw.slice(0, dm.index).trim() : raw;

  return (
    <div className={loading ? "loading" : ""}>
      <div className="wrap">
        <header className="masthead">
          <div className="brand">
            <div className="seal" aria-hidden>
              §
            </div>
            <div className="brand-text">
              <b>Municipal Record</b>
              <span>California code lookup</span>
            </div>
          </div>
          <nav>Five California cities</nav>
        </header>

        <section className="hero">
          <p className="eyebrow">Ask the code</p>
          <h1>
            Ask a question.<br />
            Get the <em>section</em>.
          </h1>
          <p className="lede">
            Ask about the municipal code of Menlo Park, Tiburon, Brisbane,
            Redding, or Benicia. Each answer quotes the sections it&rsquo;s
            based on, so you can check the source yourself.
          </p>

          <form className="console" onSubmit={onSubmit}>
            <div className="console-bar">
              <span>
                <span className="dot" />
                Inquiry
              </span>
              <span>{city ? cityName(cities, city) : "All jurisdictions"}</span>
            </div>
            <div className="ask">
              <textarea
                ref={taRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit(e);
                }}
                placeholder="e.g. What is the fence height limit for a residential front yard?"
                rows={2}
              />
              <div className="ask-controls">
                <label className="select">
                  <select value={city} onChange={(e) => setCity(e.target.value)}>
                    <option value="">All jurisdictions</option>
                    {cities.map((c) => (
                      <option key={c.slug} value={c.slug}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="spacer" />
                <button className="submit" type="submit" disabled={loading}>
                  {loading ? "Searching…" : "Look it up"}
                </button>
              </div>
            </div>
          </form>

          <div className="suggests">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                className="chip"
                type="button"
                onClick={() => {
                  setQ(s);
                  ask(s);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </section>

        <section className="result">
          {loading && (
            <p className="status">
              Reading the record<span className="scan" />
            </p>
          )}
          {error && <p className="status err">{error}</p>}

          {result && (
            <>
              <div className="answer">
                <div className="answer-top">
                  <p className="tag">Finding</p>
                  {result.city && (
                    <span className="scope-badge">
                      {cityName(cities, result.city)}
                      {result.autoCity && (
                        <em> · auto-detected</em>
                      )}
                    </span>
                  )}
                </div>
                <div className="prose">{renderMarkdown(body)}</div>
                {disclaimer && <p className="disclaimer">{disclaimer}</p>}
              </div>

              {result.sources.length > 0 && (
                <div className="sources">
                  <h2>Cited from the code · {result.sources.length} sections</h2>
                  {result.sources.map((s, i) => (
                    <div className="record" key={i}>
                      <div className="record-head">
                        <span className="stamp-chip">
                          {s.citation || s.heading?.slice(0, 24) || "§"}
                        </span>
                        <span className="record-city">{s.city}</span>
                        {s.sectionPath && (
                          <span className="record-path">{s.sectionPath}</span>
                        )}
                      </div>
                      <div className="record-body">{cleanSnippet(s.snippet)}</div>
                      <div
                        className="meter"
                        title={`relevance ${(s.score * 100).toFixed(0)}%`}
                      >
                        <i style={{ width: `${Math.round(s.score * 100)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <footer>
          <div className="jurisdictions">
            {cities.map((c) => (
              <span className="jur" key={c.slug}>
                <b>{c.name}</b> <span>· {c.chunks.toLocaleString()} passages</span>
              </span>
            ))}
          </div>
          <p className="colophon">
            Codes retrieved July 2026 from each city&rsquo;s official publisher.
            <br />
            A convenience tool, not legal advice — always verify against the
            city&rsquo;s official code.
          </p>
        </footer>
      </div>
    </div>
  );
}

function cityName(cities: City[], slug: string) {
  return cities.find((c) => c.slug === slug)?.name ?? "All jurisdictions";
}
function cleanSnippet(s: string) {
  return s.replace(/\s+/g, " ").trim().slice(0, 320);
}

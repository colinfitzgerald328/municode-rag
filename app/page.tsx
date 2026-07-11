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
  heading: string | null;
  sectionPath: string | null;
  snippet: string;
  score: number;
};
type Answer = { answer: string; sources: Source[] };

const SUGGESTIONS = [
  "What is the business license tax in Benicia?",
  "Are short-term rentals allowed in Tiburon?",
  "What are the noise ordinance rules in Menlo Park?",
  "Do I need a permit to keep chickens in Redding?",
];

// wrap section citations (§ 5.06.030, Chapter 1.04) in styled spans
function renderText(text: string) {
  const parts = text.split(/(§\s?\d[\d.\-]*|Chapter\s+[\d.]+)/g);
  return parts.map((p, i) =>
    /^(§|Chapter)/.test(p) ? (
      <span className="cite" key={i}>
        {p}
      </span>
    ) : (
      <span key={i}>{p}</span>
    )
  );
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

  // split answer body from the trailing disclaimer line
  const lines = result?.answer.split(/\n+/).filter(Boolean) ?? [];
  const disclaimerIdx = lines.findIndex((l) => /not legal advice/i.test(l));
  const body = disclaimerIdx >= 0 ? lines.slice(0, disclaimerIdx) : lines;
  const disclaimer = disclaimerIdx >= 0 ? lines[disclaimerIdx] : null;

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
          <nav>5 jurisdictions · pgvector</nav>
        </header>

        <section className="hero">
          <p className="eyebrow">Ask the code</p>
          <h1>
            Plain questions,<br />
            <em>cited</em> answers.
          </h1>
          <p className="lede">
            Search the full municipal code of five California cities in plain
            English. Every answer points back to the exact section it came from.
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
                <p className="tag">Finding</p>
                {body.map((p, i) => (
                  <p key={i}>{renderText(p)}</p>
                ))}
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
            Municipal codes retrieved July 2026. Semantic search over Neon
            pgvector · local embeddings · answers by Cerebras.
            <br />
            Convenience tool, not legal advice — verify against each city&rsquo;s
            official code.
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

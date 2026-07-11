# Municipal Record

Ask a plain-English question about the municipal code of five California cities
— **Menlo Park, Tiburon, Brisbane, Redding, Benicia** — and get an answer with
the exact section citations it came from.

Semantic search (RAG) over the full text of each city's code.

## Stack

| Layer | Choice |
|-------|--------|
| App | Next.js (App Router) |
| Vector store + search | Neon Postgres + `pgvector` (cosine, HNSW) |
| Embeddings | `fastembed` — BGE-small-en-v1.5, 384-dim, runs locally in-process (no API key) |
| LLM | Cerebras (`gemma-4-31b`), OpenAI-compatible |
| Host | Railway |

Embeddings run on the server itself, so there is no embedding API key or rate
limit. The same model embeds both the indexed passages and each query.

## Local development

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL and CEREBRAS_API_KEY
npm run ingest            # chunk + embed the codes in ./data into Neon (one-time)
npm run dev               # http://localhost:3000
```

`data/*.md` (the source codes) are git-ignored; ingest reads them locally and
loads the results into Neon. Once ingested, the app only needs the database.

## How it works

1. `scripts/ingest.ts` splits each code into ~1.8k-char section chunks, embeds
   them with fastembed, and stores them in the `chunks` table.
2. On a question, `/api/ask` embeds the query, runs a `pgvector` nearest-
   neighbor search (optionally scoped to one city), and passes the top sections
   to Cerebras with instructions to answer **only** from that context and cite
   section numbers.

## Environment variables

- `DATABASE_URL` — Neon connection string
- `CEREBRAS_API_KEY` — Cerebras API key
- `CEREBRAS_MODEL` — optional model override (default `gemma-4-31b`)

---

Convenience tool, not legal advice — always verify against each city's official
code.

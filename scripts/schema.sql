-- Municipal Record — database schema (Neon Postgres + pgvector).
-- Run once against a fresh database, then `npm run ingest`.
--   psql "$DATABASE_URL" -f scripts/schema.sql

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS cities (
  slug       text PRIMARY KEY,
  name       text NOT NULL,
  source_url text,
  platform   text,
  fetched_on date
);

CREATE TABLE IF NOT EXISTS chunks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  city_slug    text NOT NULL REFERENCES cities(slug),
  ord          int,
  citation     text,          -- section/chapter number, e.g. "5.06.030"
  chapter      text,          -- chapter number, e.g. "5.06" (derived from citation)
  chapter_name text,          -- chapter title, e.g. "Business License Tax Rates"
  heading      text,          -- section heading line
  section_path text,          -- breadcrumb (Title › Chapter/Section)
  content      text NOT NULL,
  char_len     int,
  embedding    vector(384),   -- fastembed BGE-small-en-v1.5
  -- full-text search vector over heading + content, kept in sync automatically
  tsv tsvector GENERATED ALWAYS AS
    (to_tsvector('english', coalesce(heading, '') || ' ' || content)) STORED
);

CREATE INDEX IF NOT EXISTS chunks_city_idx         ON chunks (city_slug);
CREATE INDEX IF NOT EXISTS chunks_city_chapter_idx ON chunks (city_slug, chapter);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx          ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx    ON chunks USING hnsw (embedding vector_cosine_ops);

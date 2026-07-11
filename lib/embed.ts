// Local embeddings via Qdrant fastembed (BGE-small-en-v1.5, ONNX, 384-dim).
// Runs in-process on the server — free, unlimited, no API keys or rate limits.
// The SAME model embeds both documents (ingest) and queries (search time).
import { FlagEmbedding, EmbeddingModel } from "fastembed";

export const EMBED_DIM = 384;

let _model: Promise<FlagEmbedding> | null = null;
function getModel(): Promise<FlagEmbedding> {
  if (!_model) {
    _model = FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15,
      maxLength: 512,
    });
  }
  return _model;
}

/** Embed documents/passages (no query prefix). Streams in batches. */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const model = await getModel();
  const out: number[][] = [];
  for await (const batch of model.embed(texts, 32)) {
    for (const v of batch) out.push(Array.from(v));
  }
  return out;
}

/** Embed a search query (BGE adds the retrieval instruction prefix). */
export async function embedQuery(text: string): Promise<number[]> {
  const model = await getModel();
  const v = await model.queryEmbed(text);
  return Array.from(v);
}

/** pgvector literal: [0.1,0.2,...] */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

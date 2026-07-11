// LLM generation via Cerebras (OpenAI-compatible chat completions API).
const KEY = process.env.CEREBRAS_API_KEY as string;
const MODEL = process.env.CEREBRAS_MODEL || "gemma-4-31b";
const ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function generate(system: string, user: string): Promise<string> {
  const body = JSON.stringify({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    max_completion_tokens: 1800,
  });

  // Cerebras is a shared queue and returns 429/5xx under load. Retry a few
  // times with exponential backoff (honouring Retry-After when present) before
  // giving up, so a transient spike doesn't surface as an error to the user.
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body,
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
    lastErr = `Cerebras ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (res.status !== 429 && res.status < 500) break; // client error — don't retry
    if (attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** attempt);
    }
  }
  throw new Error(lastErr);
}

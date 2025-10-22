// api/find-programs.js
// Fast cold starts
export const config = { runtime: "edge" };

// External APIs
const TAVILY_URL = "https://api.tavily.com/search";
const OPENAI_URL = "https://api.openai.com/v1/responses";

// Small helper for JSON + CORS
const j = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
    },
  });

export default async function handler(req) {
  if (req.method === "OPTIONS") return j({ ok: true });

  try {
    // 1) Read query params (with safe defaults)
    const q = Object.fromEntries(new URL(req.url).searchParams);
    const gpa      = (q.gpa ?? "3.0").toString();
    const budget   = (q.budget ?? "25000").toString();
    const program  = (q.program ?? "Computer Science").toString();
    const state    = (q.state ?? "Any").toString();
    const stemOnly = String(q.stemOnly ?? "false").toLowerCase() === "true";

    // 2) Tavily search
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) return j({ ok: false, error: "Missing TAVILY_API_KEY" }, 500);

    const searchQuery =
      `best ${program} master's programs ` +
      `${state !== "Any" ? `in ${state}` : "in the US"} ` +
      `tuition, minimum GPA, GRE/GMAT policy, scholarships ${stemOnly ? "STEM only" : ""}`.trim();

    const tRes = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${tavilyKey}`,
      },
      body: JSON.stringify({
        query: searchQuery,
        search_depth: "advanced",
        max_results: 8,
        exclude_domains: ["reddit.com", "quora.com", "medium.com"],
      }),
    });

    if (!tRes.ok) {
      const errText = await tRes.text().catch(() => "");
      return j({ ok: false, error: `Tavily HTTP ${tRes.status}: ${errText}` }, 502);
    }

    const { results = [] } = await tRes.json();
    if (!Array.isArray(results) || results.length === 0) {
      return j({ ok: false, error: "No web results found" }, 404);
    }

    // Digest for the model
    const digest = results
      .map((r, i) => `#${i + 1} ${r.title}\n${r.snippet}\nURL: ${r.url}`)
      .join("\n\n");

    // 3) OpenAI (Responses API) — keep it simple: NO response_format / text.format
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return j({ ok: false, error: "Missing OPENAI_API_KEY" }, 500);

    const systemMsg =
      `You are GradChoice AI. Return **pure JSON** (no markdown). Extract up to 3 real graduate programs ` +
      `from the snippets and rank them by fit.\n` +
      `Schema:\n{\n  "ok": true,\n  "programs": [\n    {\n      "name": "string",\n      "school": "string",\n      "tuition": number,   // annual USD estimate\n      "url": "string",\n      "minGpa": "string|null",\n      "testPolicy": "string|null",\n      "stem": boolean,\n      "deadline": "string|null",\n      "why": "string",\n      "score": number      // 0-100\n    }\n  ],\n  "notes": "string"\n}\n` +
      `Rules:\n- 3 items max in "programs".\n- Only include claims supported by the snippets.\n- If unknown, use null/\"unknown\".\n- "tuition" must be a NUMBER (no $ or commas).`;

    const userMsg =
      `User:\n- GPA: ${gpa}\n- Budget: $${budget}/yr\n- Field: ${program}\n- State: ${state}\n- STEM only: ${stemOnly}\n\n` +
      `Snippets:\n${digest}`;

    const aiRes = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: systemMsg },
          { role: "user", content: userMsg },
        ],
        max_output_tokens: 800,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      return j({ ok: false, error: `OpenAI HTTP ${aiRes.status}: ${errText}` }, 502);
    }

    const aiData = await aiRes.json();
    const raw =
      aiData?.output_text ??
      aiData?.output?.[0]?.content?.[0]?.text ??
      aiData?.output?.[0]?.content?.[0]?.string_value ??
      "";

    // 4) Parse JSON safely
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = typeof raw === "string" ? raw.match(/\{[\s\S]*\}/) : null;
      parsed = m ? JSON.parse(m[0]) : null;
    }

    if (!parsed || parsed.ok === false || !Array.isArray(parsed.programs)) {
      return j({ ok: false, error: "AI returned no usable programs", raw }, 502);
    }

    // 5) Normalize & limit
    const programs = parsed.programs.slice(0, 3).map((p) => ({
      name: String(p.name ?? "").trim(),
      school: String(p.school ?? "").trim(),
      tuition: Number.isFinite(p.tuition) ? Number(p.tuition) : null,
      url: String(p.url ?? "").trim(),
      minGpa: p.minGpa ?? null,
      testPolicy: p.testPolicy ?? null,
      stem: Boolean(p.stem),
      deadline: p.deadline ?? null,
      why: String(p.why ?? "").trim(),
      score: Number.isFinite(p.score) ? Number(p.score) : null,
    }));

    return j({
      ok: true,
      query: { gpa, budget, program, state, stemOnly, usedQuery: searchQuery },
      programs,
      notes: parsed.notes ?? null,
      count: programs.length,
    });
  } catch (err) {
    return j({ ok: false, error: String(err?.message || err) }, 500);
  }
}

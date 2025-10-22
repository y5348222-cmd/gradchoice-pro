// api/find-programs.js
// Edge runtime (fast cold starts)
export const config = { runtime: "edge" };

// --- External APIs
const TAVILY_URL = "https://api.tavily.com/search";
const OPENAI_URL = "https://api.openai.com/v1/responses";

// --- Small helper: JSON Response with headers
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // simple CORS so you can call this from your site
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
    },
  });

// --- Main handler
export default async function handler(req) {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    // -------- 1) Read query params (with safe defaults)
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const gpa = (params.gpa ?? "3.0").toString();
    const budget = (params.budget ?? "25000").toString();
    const program = (params.program ?? "Computer Science").toString();
    const state = (params.state ?? "Any").toString();
    const stemOnly = String(params.stemOnly ?? "false").toLowerCase() === "true";

    // -------- 2) Web search via Tavily
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) return json({ ok: false, error: "Missing TAVILY_API_KEY" }, 500);

    const query =
      `best ${program} master's programs ` +
      `${state !== "Any" ? `in ${state}` : "in the US"} ` +
      `tuition, minimum GPA, GRE/GMAT policy, scholarships ${stemOnly ? "STEM only" : ""}`.trim();

    const tRes = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tavilyKey}` },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        max_results: 8,
        // Keep results higher-quality; avoid forums
        exclude_domains: ["reddit.com", "quora.com", "medium.com"],
      }),
    });

    if (!tRes.ok) {
      const errText = await tRes.text().catch(() => "");
      return json({ ok: false, error: `Tavily HTTP ${tRes.status}: ${errText}` }, 502);
    }

    const { results = [] } = await tRes.json();
    const snippets = results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    }));

    // A compact digest the model can read easily
    const digest = snippets
      .map((r, i) => `#${i + 1} ${r.title}\n${r.snippet}\nURL: ${r.url}`)
      .join("\n\n");

    // -------- 3) Score + extract with OpenAI (Responses API)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return json({ ok: false, error: "Missing OPENAI_API_KEY" }, 500);

    // Use distinct variable names (avoid redeclare errors)
    const systemMsg =
      `You are GradChoice AI. Return **pure JSON** only (no markdown). ` +
      `Extract up to 3 graduate programs from the provided web snippets and rank them by fit. ` +
      `Schema:\n` +
      `{\n  "ok": true,\n  "programs": [\n    {\n      "name": "string", // program name\n      "school": "string",\n      "tuition": number,   // annual USD estimate\n      "url": "string",\n      "minGpa": "string|null",\n      "testPolicy": "string|null",\n      "stem": boolean,\n      "deadline": "string|null",\n      "why": "string",\n      "score": number      // 0-100\n    }\n  ],\n  "notes": "string"\n}\n` +
      `Rules:\n- 3 items max in "programs".\n- Only use content supported by the snippets.\n- If data is unknown, set a sensible null/unknown value.\n- Tuition must be a number (no $ or commas).`;

    const userMsg =
      `User profile:\n` +
      `- GPA: ${gpa}\n- Budget: $${budget}/yr\n- Field: ${program}\n` +
      `- State preference: ${state}\n- STEM only: ${stemOnly}\n\n` +
      `Snippets:\n${digest}`;

    const aiRes = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        // “input” is the new Responses API messages field
        input: [
          { role: "system", content: systemMsg },
          { role: "user", content: userMsg },
        ],
        response_format: { type: "json" },
        max_output_tokens: 800,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      return json({ ok: false, error: `OpenAI HTTP ${aiRes.status}: ${errText}` }, 502);
    }

    const aiData = await aiRes.json();

    // Responses API can return in a few shapes; check common ones
    const rawText =
      aiData?.output_text ??
      aiData?.output?.[0]?.content?.[0]?.text ??
      aiData?.output?.[0]?.content?.[0]?.string_value ??
      "";

    // -------- 4) Parse JSON (with fallback)
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const m = rawText.match(/\{[\s\S]*\}/); // best-effort JSON block
      parsed = m ? JSON.parse(m[0]) : null;
    }

    if (!parsed || parsed.ok === false || !Array.isArray(parsed.programs)) {
      return json({ ok: false, error: "AI returned no usable programs", raw: rawText }, 502);
    }

    // -------- 5) Normalize & limit
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

    return json({
      ok: true,
      query: { gpa, budget, program, state, stemOnly, usedQuery: query },
      programs,
      notes: parsed.notes ?? null,
      count: programs.length,
    });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}

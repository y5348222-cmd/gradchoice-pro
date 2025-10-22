// api/find-programs.js
export const config = { runtime: "edge" };

const TAVILY_URL = "https://api.tavily.com/search";
const OPENAI_URL = "https://api.openai.com/v1/responses";

// ---- JSON + CORS helper ----
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
    // 1) Read query params (with defaults)
    const q = Object.fromEntries(new URL(req.url).searchParams);
    const gpa      = (q.gpa ?? "3.0").toString();
    const budget   = (q.budget ?? "25000").toString();
    const program  = (q.program ?? "Computer Science").toString();
    const state    = (q.state ?? "Any").toString();
    const stemOnly = String(q.stemOnly ?? "false").toLowerCase() === "true";
    const openaiOff = String(q.openai ?? "on").toLowerCase() === "off";

    // 2) Tavily: live web candidates
    const tvlyKey = process.env.TAVILY_API_KEY;
    if (!tvlyKey) return j({ ok:false, error:"Missing TAVILY_API_KEY" }, 500);

    const searchQuery =
      `best ${program} master's programs ` +
      `${state !== "Any" ? `in ${state}` : "in the US"} ` +
      `tuition, minimum GPA, GRE/GMAT policy, scholarships ${stemOnly ? "STEM only" : ""}`.trim();

    const tRes = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Tavily auth header:
        "Authorization": `Bearer ${tvlyKey}`,
        // If your key expects `x-api-key` instead in your account, swap the line above for:
        // "x-api-key": tvlyKey,
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
      return j({ ok:false, error:`Tavily HTTP ${tRes.status}: ${errText}` }, 502);
    }

    const { results = [] } = await tRes.json();
    if (!Array.isArray(results) || results.length === 0) {
      return j({ ok:false, error:"No web results found" }, 404);
    }

    const snippets = results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    }));

    const digest = snippets
      .map((r,i)=>`#${i+1} ${r.title}\n${r.snippet}\nURL: ${r.url}`)
      .join("\n\n")
      .slice(0, 4000); // keep prompt compact

    // 3) OpenAI: extract + rank programs (no local JSON fallback)
    if (openaiOff) return j({ ok:false, error:"OpenAI disabled via ?openai=off" }, 400);

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return j({ ok:false, error:"Missing OPENAI_API_KEY" }, 500);

    const instructions = `
You are GradChoice AI. Return pure JSON only (no markdown).
Extract up to 3 real master's programs that fit the user and rank by fit.

Required schema:
{
  "ok": true,
  "programs": [
    {
      "name": "string",
      "school": "string",
      "tuition": 12345,          // number only; null if unknown
      "url": "string",
      "minGpa": "string|null",
      "testPolicy": "string|null",
      "stem": true,
      "deadline": "string|null",
      "why": "string",
      "score": 0                 // 0-100
    }
  ],
  "notes": "string"
}

Rules:
- Use ONLY facts supported by the provided web snippets.
- If unknown, set to null (or "unknown" for text).
- Max 3 items. Keep "why" short.
`.trim();

    const userContext = `
User: GPA ${gpa}, Budget $${budget}/yr, Field ${program}, State ${state}, STEM ${stemOnly}
Snippets:
${digest}
`.trim();

    const aiRes = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",   // good + cheaper; change to a pricier model if you want
        input: `${instructions}\n\n${userContext}`,
        temperature: 0.2,
        max_output_tokens: 600,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      return j({ ok:false, error:`OpenAI HTTP ${aiRes.status}: ${errText}` }, 502);
    }

    const aiData = await aiRes.json();
    const raw =
      aiData?.output_text ??
      aiData?.output?.[0]?.content?.[0]?.text ??
      aiData?.output?.[0]?.content?.[0]?.string_value ??
      "";

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = typeof raw === "string" ? raw.match(/\{[\s\S]*\}/) : null;
      parsed = m ? JSON.parse(m[0]) : null;
    }

    const aiPrograms = Array.isArray(parsed?.programs)
      ? parsed.programs.slice(0,3).map(p => ({
          name: String(p.name ?? "").trim(),
          school: String(p.school ?? "").trim(),
          tuition: Number.isFinite(p.tuition) ? Number(p.tuition) : null,
          url: String(p.url ?? "").trim(),
          minGpa: p.minGpa ?? null,
          testPolicy: p.testPolicy ?? null,
          stem: typeof p.stem === "boolean" ? p.stem : null,
          deadline: p.deadline ?? null,
          why: String(p.why ?? "").trim(),
          score: Number.isFinite(p.score) ? Number(p.score) : null,
        }))
      : [];

    if (aiPrograms.length === 0) {
      return j({
        ok: false,
        error: "AI did not return structured programs. Try adjusting filters or query.",
        usedQuery: searchQuery,
      }, 424);
    }

    // 4) Success — AI programs only
    return j({
      ok: true,
      query: { gpa, budget, program, state, stemOnly, usedQuery: searchQuery },
      programs: aiPrograms,
      notes: parsed?.notes ?? null,
      count: aiPrograms.length,
    });

  } catch (err) {
    return j({ ok:false, error: String(err?.message || err) }, 500);
  }
}

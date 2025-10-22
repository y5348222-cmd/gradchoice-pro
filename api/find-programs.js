// api/find-programs.js
export const config = { runtime: "edge" };

const TAVILY_URL = "https://api.tavily.com/search";
const OPENAI_URL = "https://api.openai.com/v1/responses";

// --- JSON + CORS helper ---
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
    // 1) read query
    const q = Object.fromEntries(new URL(req.url).searchParams);
    const gpa      = (q.gpa ?? "3.0").toString();
    const budget   = (q.budget ?? "25000").toString();
    const program  = (q.program ?? "Computer Science").toString();
    const state    = (q.state ?? "Any").toString();
    const stemOnly = String(q.stemOnly ?? "false").toLowerCase() === "true";
    const openaiOff = String(q.openai ?? "on").toLowerCase() === "off";

    // 2) Tavily
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
        "X-Tavily-Key": tvlyKey,         // <-- correct header
      },
      body: JSON.stringify({
        query: searchQuery,
        search_depth: "advanced",
        max_results: 8,
        exclude_domains: ["reddit.com","quora.com","medium.com"],
      }),
    });

    if (!tRes.ok) {
      const err = await tRes.text().catch(()=>"");
      return j({ ok:false, error:`Tavily HTTP ${tRes.status}: ${err}` }, 502);
    }
    const { results = [] } = await tRes.json();
    if (!Array.isArray(results) || results.length === 0) {
      return j({ ok:false, error:"No web results found" }, 404);
    }

    const snippets = results.map(r => ({
      title: r.title, url: r.url, snippet: r.snippet
    }));

    const digest = snippets
      .map((r,i)=>`#${i+1} ${r.title}\n${r.snippet}\nURL: ${r.url}`)
      .join("\n\n")
      .slice(0, 4000);

    // 3) OpenAI (Responses API)
    const oaiKey = process.env.OPENAI_API_KEY;
    let aiPrograms = null;
    let note = null;

    if (!openaiOff && oaiKey) {
      const instructions = `
You are GradChoice AI. Return **pure JSON** only (no markdown).
Extract up to 3 *real* master's programs that fit the user and rank by fit.

Required JSON schema:
{
  "ok": true,
  "programs": [
    {
      "name": "string",
      "school": "string",
      "tuition": 12345,               // number only, per year if known; null if unknown
      "url": "string",
      "minGpa": "string|null",
      "testPolicy": "string|null",
      "stem": true,
      "deadline": "string|null",
      "why": "string",
      "score": 0                      // 0-100
    }
  ],
  "notes": "string"
}

Rules:
- Use ONLY facts supported by the provided web snippets.
- If unknown, set field to null (or "unknown" for text fields as appropriate).
- Max 3 items. Keep "why" short.
`.trim();

      const userContext = `
User: GPA ${gpa}, Budget $${budget}/yr, Field ${program}, State ${state}, STEM ${stemOnly}
Snippets:
${digest}
`.trim();

      // Responses API expects an "input" string (or content parts). Keep it simple.
      const r = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${oaiKey}`
        },
        body: JSON.stringify({
          model: "gpt-5",                 // use your paid model
          input: `${instructions}\n\n${userContext}`,
          temperature: 0.2,
          max_output_tokens: 600
        })
      });

      if (!r.ok) {
        const err = await r.text().catch(()=>"");
        if (r.status === 429 || /quota|rate/i.test(err)) {
          note = `OpenAI limit/quota: ${err}`;
        } else {
          throw new Error(`OpenAI HTTP ${r.status}: ${err}`);
        }
      } else {
        const data = await r.json();
        const raw = data?.output_text ?? "";
        try {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.programs)) {
            aiPrograms = parsed.programs.slice(0,3).map(p => ({
              name: String(p.name ?? "").trim(),
              school: String(p.school ?? "").trim(),
              tuition: Number.isFinite(p.tuition) ? Number(p.tuition) : null,
              url: String(p.url ?? "").trim(),
              minGpa: p.minGpa ?? null,
              testPolicy: p.testPolicy ?? null,
              stem: typeof p.stem === "boolean" ? p.stem : null,
              deadline: p.deadline ?? null,
              why: String(p.why ?? "").trim(),
              score: Number.isFinite(p.score) ? Number(p.score) : null
            }));
            note = parsed.notes ?? null;
          } else {
            note = "OpenAI returned non-JSON; showing web candidates";
          }
        } catch {
          note = "OpenAI JSON parse failed; showing web candidates";
        }
      }
    } else if (!oaiKey && !openaiOff) {
      note = "Missing OPENAI_API_KEY — showing web candidates";
    } else if (openaiOff) {
      note = "OpenAI disabled via ?openai=off — showing web candidates";
    }

    // 4) Fallback if AI missing
    const programs = aiPrograms ?? snippets.slice(0,3).map(r => ({
      name: "(unknown — open page)",
      school: r.title,
      tuition: null,
      url: r.url,
      minGpa: null,
      testPolicy: null,
      stem: null,
      deadline: null,
      why: `Candidate for ${program}. Open link to confirm tuition/GPA/policy.`,
      score: null
    }));

    return j({
      ok: true,
      query: { gpa, budget, program, state, stemOnly, usedQuery: searchQuery },
      programs,
      notes: note,
      count: programs.length
    });
  } catch (err) {
    return j({ ok:false, error: String(err?.message || err) }, 500);
  }
}

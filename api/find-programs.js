// api/find-programs.js
// Fast edge route
export const config = { runtime: "edge" };

const TAVILY_URL = "https://api.tavily.com/search";
const OPENAI_URL = "https://api.openai.com/v1/responses";

// JSON + CORS helper
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
    // ---------- 1) Read query params (with defaults)
    const q = Object.fromEntries(new URL(req.url).searchParams);
    const gpa      = (q.gpa ?? "3.0").toString();
    const budget   = (q.budget ?? "25000").toString();
    const program  = (q.program ?? "Computer Science").toString();
    const state    = (q.state ?? "Any").toString();
    const stemOnly = String(q.stemOnly ?? "false").toLowerCase() === "true";
    const openaiOff = String(q.openai ?? "on").toLowerCase() === "off";

    // ---------- 2) Tavily search
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

    // Build a readable digest for the model and a normalized snippet list
    const snippets = results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    }));

    const digest = snippets
      .map((r, i) => `#${i + 1} ${r.title}\n${r.snippet}\nURL: ${r.url}`)
      .join("\n\n")
      .slice(0, 4000); // keep prompt compact/cheap

    // ---------- 3) Try OpenAI (Responses API) — with graceful fallback
    const openaiKey = process.env.OPENAI_API_KEY;
    let aiPrograms = null;
    let note = null;

    if (!openaiOff && openaiKey) {
      const systemMsg =
        `You are GradChoice AI. Return pure JSON only (no markdown). ` +
        `Extract up to 3 real graduate programs from the provided web snippets and rank them by fit. ` +
        `Schema: {"ok":true,"programs":[{"name":"string","school":"string","tuition":number,"url":"string","minGpa":"string|null","testPolicy":"string|null","stem":boolean,"deadline":"string|null","why":"string","score":number}],"notes":"string"}` +
        ` Rules: max 3 items; only use info supported by snippets; unknown fields -> null/"unknown"; tuition must be NUMBER (no $ or commas).`;

      const userMsg =
        `User: GPA ${gpa}, Budget $${budget}/yr, Field ${program}, State ${state}, STEM ${stemOnly}\n\n` +
        `Snippets:\n${digest}`;

      try {
        const aiRes = await fetch(OPENAI_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${openaiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            // We rely on instruction to return JSON; no special format field.
            input: [
              { role: "system", content: systemMsg },
              { role: "user", content: userMsg },
            ],
            max_output_tokens: 450,
          }),
        });

        if (!aiRes.ok) {
          const errText = await aiRes.text().catch(() => "");
          // If quota or rate limit, don’t fail — fall back to Tavily-only
          if (aiRes.status === 429 || /insufficient_quota|rate limit/i.test(errText)) {
            note = `OpenAI quota/limit: ${errText}`;
          } else {
            throw new Error(`OpenAI HTTP ${aiRes.status}: ${errText}`);
          }
        } else {
          const aiData = await aiRes.json();
          const raw =
            aiData?.output_text ??
            aiData?.output?.[0]?.content?.[0]?.text ??
            aiData?.output?.[0]?.content?.[0]?.string_value ??
            "";

          // Parse robustly
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            const m = typeof raw === "string" ? raw.match(/\{[\s\S]*\}/) : null;
            parsed = m ? JSON.parse(m[0]) : null;
          }

          if (parsed && Array.isArray(parsed.programs)) {
            aiPrograms = parsed.programs.slice(0, 3).map((p) => ({
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
            }));
            note = parsed.notes ?? null;
          } else {
            note = "OpenAI returned unparseable JSON — showing web candidates";
          }
        }
      } catch (e) {
        note = `OpenAI error: ${String(e?.message || e)}`;
      }
    } else if (!openaiKey && !openaiOff) {
      note = "Missing OPENAI_API_KEY — showing web candidates";
    } else if (openaiOff) {
      note = "OpenAI disabled via ?openai=off — showing web candidates";
    }

    // ---------- 4) If OpenAI failed/disabled, build Tavily-only candidates
    const programs = aiPrograms
      ? aiPrograms
      : snippets.slice(0, 3).map((r) => ({
          name: "(unknown — open page)",
          school: r.title,
          tuition: null,
          url: r.url,
          minGpa: null,
          testPolicy: null,
          stem: null,
          deadline: null,
          why: `Candidate found for ${program}. Open the page to confirm tuition, GPA and policy.`,
          score: null,
        }));

    return j({
      ok: true,
      query: { gpa, budget, program, state, stemOnly, usedQuery: searchQuery },
      programs,
      notes: note,
      count: programs.length,
    });
  } catch (err) {
    return j({ ok: false, error: String(err?.message || err) }, 500);
  }
}

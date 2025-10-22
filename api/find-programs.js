// api/find-programs.js
export const config = { runtime: "edge" };

const OPENAI_URL = "https://api.openai.com/v1/responses";
const TAVILY_URL = "https://api.tavily.com/search";

export default async function handler(req) {
  try {
    const { gpa = "3.0", budget = "25000", program = "Computer Science", state = "Any", stemOnly = false } =
      Object.fromEntries(new URL(req.url).searchParams);

    // 1️⃣ Search the web using Tavily
    const query = `best ${program} master's programs ${state !== "Any" ? "in " + state : "in the US"} tuition, minimum GPA, GRE policy, scholarships, STEM`;
    const tRes = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        max_results: 8,
        exclude_domains: ["reddit.com", "quora.com", "medium.com"],
      }),
    });

    if (!tRes.ok) throw new Error("Tavily search failed");
    const { results = [] } = await tRes.json();

    const digest = results.map(r => `- ${r.title}\n${r.snippet}\nURL: ${r.url}`).join("\n\n");

    // 2️⃣ Send to OpenAI for ranking
    const system = `Extract and rank graduate programs from the given web data.
Return JSON like:
[{school, program, url, estimatedTuition, minGpa, testPolicy, stem, deadline, why, score}]
Score 0–100 by how well they match the user.`;

    const user = `User: GPA ${gpa}, budget ${budget}, program ${program}, state ${state}, STEM only: ${stemOnly}
Data:
${digest}`;

    // ---- OpenAI: score + summarize Tavily results ----
const OPENAI_URL = "https://api.openai.com/v1/responses";
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) {
  throw new Error("Missing OPENAI_API_KEY");
}

const system = `
You are a program-matching assistant. Return pure JSON.
Schema:
{
  "ok": true,
  "programs": [
    {
      "name": "string",
      "school": "string",
      "tuition": "number",
      "url": "string",
      "why": "string"
    }
  ],
  "notes": "string"
}
Rules:
- 3 items max in "programs".
- tuition is an annual USD estimate (number).
- Only include real results from the provided web snippets.
`;

const user = \`User: GPA ${gpa}, budget $${budget}, field ${program}.
Use these web snippets to pick the best 3 programs and explain why each fits (budget/GPA/policy).
Return JSON only (no markdown). Snippets: ${JSON.stringify(snippets)}\`;

const aiRes = await fetch(OPENAI_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": \`Bearer ${OPENAI_KEY}\`
  },
  body: JSON.stringify({
    model: "gpt-4o-mini", // safe model for production
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    max_output_tokens: 800
  })
});

if (!aiRes.ok) {
  const errText = await aiRes.text().catch(() => "");
  throw new Error(\`OpenAI HTTP ${aiRes.status}: ${errText}\`);
}

const data = await aiRes.json();
const text =
  data?.output_text ||
  data?.output?.[0]?.content?.[0]?.text ||
  "";

let json;
try {
  json = JSON.parse(text);
} catch {
  const m = text.match(/\{[\s\S]*\}/);
  json = m ? JSON.parse(m[0]) : { ok: false, error: "Could not parse AI JSON" };
}

if (!json || json.ok === false) {
  throw new Error("AI returned no programs");
}

return new Response(JSON.stringify(json), {
  headers: { "Content-Type": "application/json" }
});

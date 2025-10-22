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

    const aiRes = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5",
        input: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json" },
        max_output_tokens: 800,
      }),
    });

    if (!aiRes.ok) throw new Error("OpenAI failed");
    const data = await aiRes.json();

    let items = [];
    try {
      items = JSON.parse(data.output[0].content[0].text);
    } catch (e) {}

    const top = (Array.isArray(items) ? items : []).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3);

    return new Response(JSON.stringify({ ok: true, top }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

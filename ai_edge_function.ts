// Supabase Edge Function: "ai"  (calls Gemini; your API key stays on the server)
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const KEY = Deno.env.get("AQ.Ab8RN6KWn0EjX7oTKrJ1I-tekEYBv8_-g45QxARINx0MzCFOpA");
const MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const out = (o) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });

async function gem(system, user) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192, responseMimeType: "application/json" },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "The AI request failed.");
  const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!t) throw new Error("The AI returned an empty answer. Try again.");
  return JSON.parse(t.replace(/^```json\s*|```\s*$/g, "").trim());
}

const okQ = (q) =>
  q && typeof q.q === "string" &&
  (q.type === "short"
    ? typeof q.answer === "string"
    : Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!KEY) return out({ error: "GEMINI_API_KEY is not set for this function." });
    const b = await req.json();

    if (b.task === "quiz") {
      const n = Math.min(Math.max(parseInt(b.n) || 5, 1), 25);
      const kind = ["mcq", "tf", "short", "mixed"].includes(b.kind) ? b.kind : "mcq";
      const diff = ["easy", "medium", "hard"].includes(b.difficulty) ? b.difficulty : "medium";
      const mat = String(b.material || "").slice(0, 40000);
      if (mat.length < 100) return out({ error: "There is not enough study material to write questions from." });
      const spec = {
        mcq: "all multiple choice",
        tf: "all true/false",
        short: "all short-answer theory questions",
        mixed: "a mix: about 60% multiple choice, 20% true/false, 20% short-answer",
      }[kind];
      const sys = "You write exam questions strictly from the study material supplied. Use only facts stated in it; never add outside knowledge. Reply with JSON only.";
      const usr = `Study material:\n"""\n${mat}\n"""\n\nWrite ${n} ${diff} questions: ${spec}.\nReturn {"questions":[...]} where each item is one of:\n{"type":"mcq","q":"...","options":["text","text","text","text"],"answer":0,"explanation":"..."}\n{"type":"tf","q":"...","options":["True","False"],"answer":0,"explanation":"..."}\n{"type":"short","q":"...","answer":"model answer","marks":5}\nFor mcq and tf, "answer" is the zero-based index of the correct option. Do not put letters like "A)" in the options. Each explanation must say why the answer is correct, based on the material. Cover different topics from the material.`;
      const d = await gem(sys, usr);
      return out({ questions: (d.questions || d || []).filter(okQ) });
    }

    if (b.task === "ticket_help") {
      const text = String(b.text || "").slice(0, 2000);
      const sys = `You are the support assistant for a university Computer & Robotics Education department portal. The portal has: a lecturers directory, course materials (PDFs), assessments and drill tests, results with GPA/CGPA, a calendar, support tickets and alerts. You cannot see or change anyone's grades or account, and you must not promise that a result or account will be changed. Missing or wrong results, login or account problems, and anything needing staff action should become a support ticket. Be brief, friendly and practical. Reply with JSON only: {"answer": string of at most 120 words, "ticket": null or {"subject": string, "message": string, "priority": "Low"|"Medium"|"High"|"Urgent"}}. In the ticket message, tell the student to include their reg number, course code, session and what exactly is wrong if they have not said so.`;
      return out(await gem(sys, `Student's message:\n"""\n${text}\n"""`));
    }

    if (b.task === "ticket_reply") {
      const sys = `You help a department administrator draft a short, polite reply to a student's support ticket. Do not invent facts, dates or outcomes, and do not promise that anything will be changed. If key details are missing (reg number, course code, session), ask for them. Reply with JSON only: {"reply": string}`;
      return out(await gem(sys, JSON.stringify({ ticket: b.ticket, earlier_replies: b.replies }).slice(0, 6000)));
    }

    return out({ error: "Unknown request." });
  } catch (e) {
    return out({ error: String(e.message || e) });
  }
});

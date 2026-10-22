// Supabase Edge Function: "ai"  (calls Gemini; your API key stays on the server)
// Resilience: retries with backoff, automatic fallback to other models, and a question bank cache.
// Speed: low "thinking" effort, a fast model for short support tasks, and big quizzes written in parallel.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400", // lets the browser skip the extra "preflight" round trip on repeat calls
};
const KEY = Deno.env.get("GEMINI_API_KEY");
const PRIMARY = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
// Tried in order when the primary model is busy. Override with the GEMINI_FALLBACKS secret (comma separated).
const FALLBACKS = (Deno.env.get("GEMINI_FALLBACKS") || "gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MODELS = [PRIMARY, ...FALLBACKS.filter((m) => m !== PRIMARY)];
// Short support tasks go to this quick model first. Override with the GEMINI_FAST_MODEL secret.
const FAST = Deno.env.get("GEMINI_FAST_MODEL") || "gemini-3.5-flash-lite";
const FAST_MODELS = [FAST, ...MODELS.filter((m) => m !== FAST)];
// How hard the model thinks before answering: minimal | low | medium | high. Lower is faster.
const THINK = Deno.env.get("GEMINI_THINKING") || "low";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const out = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class AIError extends Error {
  retryable: boolean;
  constructor(m: string, retryable = false) { super(m); this.retryable = retryable; }
}
const BUSY = new Set([429, 500, 502, 503, 504]);
const DEADLINE_MS = 100_000;

type Opts = { fast?: boolean; maxOut?: number };

async function gem(system: string, user: string, opts: Opts = {}) {
  const t0 = Date.now();
  const models = opts.fast ? FAST_MODELS : MODELS;
  let thinking = THINK !== "off"; // switched off for the rest of this call if a model rejects the setting
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - t0 > DEADLINE_MS) throw new AIError("The AI is taking too long right now. Please try again in a minute.", true);
      let r: Response;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": KEY! },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: opts.maxOut || 8192,
              responseMimeType: "application/json",
              ...(thinking ? { thinkingConfig: { thinkingLevel: THINK } } : {}),
            },
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        if ((e as Error)?.name === "TimeoutError") break; // too slow: try the next model instead of waiting again
        await sleep(300 * (attempt + 1));
        continue; // network blip: retry once
      }
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const t = (j.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || "").join("");
        if (!t) continue;
        try { return JSON.parse(t.replace(/^```json\s*|```\s*$/g, "").trim()); } catch (_e) { continue; }
      }
      const msg = j.error?.message || `HTTP ${r.status}`;
      if (r.status === 401 || r.status === 403) throw new AIError("The AI key was rejected. Ask the admin to check GEMINI_API_KEY.");
      if (r.status === 400 && thinking && /think/i.test(msg)) { thinking = false; continue; } // this model does not accept the thinking setting
      if (r.status === 404 || (r.status === 400 && /model/i.test(msg))) break; // this model is unavailable: go to the next one
      if (r.status === 400) throw new AIError(msg);
      if (BUSY.has(r.status)) { if (attempt === 0) await sleep(500 + Math.random() * 500); continue; }
      throw new AIError(msg);
    }
  }
  throw new AIError("The AI is very busy right now. Please try again in a minute.", true);
}

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function cacheGet(key: string) {
  try { const { data } = await sb.from("ai_cache").select("data").eq("key", key).maybeSingle(); return data?.data ?? null; } catch (_e) { return null; }
}
async function cacheSet(key: string, task: string, data: unknown) {
  try { await sb.from("ai_cache").upsert({ key, task, data, updated_at: new Date().toISOString() }); } catch (_e) { /* cache is optional */ }
}
const shuffle = <T,>(a: T[]) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const okQ = (q: any) =>
  q && typeof q.q === "string" &&
  (q.type === "short"
    ? typeof q.answer === "string"
    : Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);

const ORD = ["first", "second", "third", "fourth"];

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

      // Question bank: reuse questions already written for this exact material, kind and difficulty.
      const key = "quiz:" + await sha(`${kind}|${diff}|${mat}`);
      const bank: any[] = (await cacheGet(key))?.questions || [];
      if (bank.length >= n * 2) return out({ questions: shuffle(bank).slice(0, n), cached: true });

      const spec = {
        mcq: "all multiple choice",
        tf: "all true/false",
        short: "all short-answer theory questions",
        mixed: "a mix: about 60% multiple choice, 20% true/false, 20% short-answer",
      }[kind];
      const sys = "You write exam questions strictly from the study material supplied. Use only facts stated in it; never add outside knowledge. Reply with JSON only.";
      const ask = (cn: number, part: number, parts: number) =>
        `Study material:\n"""\n${mat}\n"""\n\nWrite ${cn} ${diff} questions: ${spec}.${parts > 1 ? ` This is part ${part} of ${parts} written at the same time by different writers: draw your questions mainly from the ${ORD[part - 1]} ${parts == 2 ? "half" : parts == 3 ? "third" : "quarter"} of the material so the parts do not repeat each other.` : ""}\nReturn {"questions":[...]} where each item is one of:\n{"type":"mcq","q":"...","options":["text","text","text","text"],"answer":0,"explanation":"..."}\n{"type":"tf","q":"...","options":["True","False"],"answer":0,"explanation":"..."}\n{"type":"short","q":"...","answer":"model answer","marks":5}\nFor mcq and tf, "answer" is the zero-based index of the correct option. Do not put letters like "A)" in the options. Each explanation must say why the answer is correct, based on the material. Cover different topics from the material.`;

      // Big quizzes are split into parts that are written at the same time, so they finish sooner.
      const parts = n > 10 ? Math.min(4, Math.ceil(n / 8)) : 1;
      const sizes = Array.from({ length: parts }, (_, i) => Math.floor(n / parts) + (i < n % parts ? 1 : 0));

      let fresh: any[];
      try {
        const runs = await Promise.allSettled(
          sizes.map((cn, i) => gem(sys, ask(cn, i + 1, parts), { maxOut: Math.min(8192, cn * 500 + 1200) })),
        );
        const good = runs.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled");
        if (!good.length) throw (runs[0] as PromiseRejectedResult).reason;
        const seenNow = new Set<string>();
        fresh = good.flatMap((r) => (r.value.questions || r.value || []) as any[]).filter(okQ).filter((q) => {
          const k = q.q.trim().toLowerCase();
          if (seenNow.has(k)) return false;
          seenNow.add(k);
          return true;
        });
        if (!fresh.length) throw new AIError("The AI did not return usable questions. Please try again.", true);
      } catch (e) {
        // AI is overloaded: still let the student practise from the saved bank if it has enough questions.
        if (bank.length >= Math.min(n, 8)) return out({ questions: shuffle(bank).slice(0, n), cached: true });
        throw e;
      }
      const seen = new Set(bank.map((q) => q.q.trim().toLowerCase()));
      const added = fresh.filter((q) => !seen.has(q.q.trim().toLowerCase()));
      if (added.length) await cacheSet(key, "quiz", { questions: [...bank, ...added].slice(-150) });
      return out({ questions: fresh });
    }

    if (b.task === "summarize") {
      const mat = String(b.material || "").slice(0, 50000);
      if (mat.length < 200) return out({ error: "There is not enough text to summarize." });
      const key = "sum:" + await sha(`${b.mode === "part" ? "part" : "full"}|${mat}`);
      const hit = await cacheGet(key);
      if (hit) return out(hit);
      const sys = "You summarize university course material for students. Use only what is in the material; never add outside facts. Write clearly and simply. Reply with JSON only.";
      const usr = b.mode === "part"
        ? `Course material (one section of a longer document):\n"""\n${mat}\n"""\n\nExtract concise study notes from this section: its main ideas, definitions, steps, formulas and examples. Return {"notes": "..."} with at most 450 words.`
        : `Course material (or condensed notes from a long document):\n"""\n${mat}\n"""\n\nSummarize this for a student who needs to revise quickly. Return {"overview": "2 to 3 sentences on what the document covers", "key_points": ["8 to 15 short, clear points in the order they appear"], "key_terms": [{"term": "...", "meaning": "one-sentence definition from the material"}]} with up to 10 key terms.`;
      const res = await gem(sys, usr, { maxOut: 3500 });
      await cacheSet(key, "summarize", res);
      return out(res);
    }

    if (b.task === "ticket_help") {
      const text = String(b.text || "").slice(0, 2000);
      const facts = JSON.stringify(b.context ?? {}).slice(0, 9000);
      const hist = (Array.isArray(b.history) ? b.history : []).slice(-6)
        .map((m: any) => `${m?.role === "user" ? "Student" : "Assistant"}: ${String(m?.text || "").slice(0, 600)}`).join("\n");
      const sys = `You are the support assistant inside a university department portal (Computer and Robotics Education). You are talking to one student and you are given FACTS read from that student's own account. Solve the problem yourself whenever the facts allow it. Send it to staff only when staff really must act.

The portal has: a lecturers directory, course materials (PDFs with AI summaries), Assess (tests set by lecturers with a passcode and a timer, plus AI practice drills), Results (scores, grades, GPA and CGPA), a calendar, support tickets, alerts, and Profile (change email, phone and password). Forgotten password: on the sign-in page tap "Forgot password?", enter the registration number and the email saved on the account, and a 6-digit code is emailed. That only works if an email is saved on the account.

How to work:
- Read the FACTS first and be specific: name the courses, scores, grades, dates and tests you see. Never invent anything that is not in the FACTS or the conversation.
- Missing result: look at "results" and "courses_at_my_level_with_no_result". If a course is listed there with results_uploaded_for_other_students equal to 0, say that results for that course have not been uploaded for anyone yet, so it is not a problem with their account, and staff must upload them. If other students have results but this student does not, the result may be missing from the sheet or the registration number was mistyped: raise a ticket. Note that the list can include courses from the other semester that the student has not taken yet, so say "if you wrote this course".
- Wrong score or grade: explain how the grade is worked out. You cannot change a score. If they still think it is wrong, raise a ticket with the course, session and the score they expected.
- GPA or CGPA: use the cgpa and grading rules in the FACTS and explain; do not do new arithmetic beyond what the FACTS show.
- Password or login: if email_on_file is false, ask them for the email to save and explain it is needed for password reset. If they type an email address, offer the set_email action (you do not save it yourself). If they are locked out and cannot reset, raise a ticket (category Account).
- Tests: use "tests" to say whether a test is open, submitted (with the score) or started but not submitted. A test cannot be retaken after submitting; a start that was never submitted and timed out needs a ticket to the lecturer or admin. Wrong passcode attempts lock a test for 15 minutes after 5 tries.
- Dates: use "upcoming_events".
You cannot change grades, accounts or any data, and you must not promise that anything will be changed. Say that staff will review it.
Keep the answer short (under 120 words), friendly and in plain English. Use a short numbered list for steps.

Optional ACTIONS (at most 3, only ones that really help):
- {"type":"open_page","page":"res"|"mat"|"cal"|"exam"|"nf"|"dir"|"prof","label":"short text"}
- {"type":"ticket","subject":"...","message":"...","priority":"Low"|"Medium"|"High"|"Urgent","category":"General"|"Results"|"Account"|"Materials"|"Other"} only when staff must act. The message must include the registration number, course code(s), session and exactly what is wrong, copied from the FACTS.
- {"type":"set_email","email":"..."} only when the student has typed an email address to save.
Reply with JSON only: {"answer": string, "actions": array (can be empty)}`;
      const usr = `FACTS (read from this student's own account):\n${facts}\n\n${hist ? `Conversation so far:\n${hist}\n\n` : ""}The student now says:\n"""\n${text}\n"""`;
      const res = await gem(sys, usr, { maxOut: 2200 });
      const PAGES = ["res", "mat", "cal", "exam", "nf", "dir", "prof"];
      const PRI = ["Low", "Medium", "High", "Urgent"];
      const CAT = ["General", "Results", "Account", "Materials", "Other"];
      const actions = (Array.isArray(res?.actions) ? res.actions : []).slice(0, 10).map((a: any) => {
        if (a?.type === "open_page" && PAGES.includes(a.page)) return { type: "open_page", page: a.page, label: String(a.label || "").slice(0, 40) };
        if (a?.type === "ticket" && a.subject && a.message) {
          return { type: "ticket", subject: String(a.subject).slice(0, 150), message: String(a.message).slice(0, 1500),
            priority: PRI.includes(a.priority) ? a.priority : "Medium", category: CAT.includes(a.category) ? a.category : "General" };
        }
        if (a?.type === "set_email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(a.email || ""))) return { type: "set_email", email: String(a.email).toLowerCase().slice(0, 120) };
        return null;
      }).filter(Boolean).slice(0, 3);
      const t = (actions as any[]).find((a) => a.type === "ticket");
      return out({ answer: String(res?.answer || "").slice(0, 1500), actions, ticket: t ? { subject: t.subject, message: t.message, priority: t.priority } : null });
    }

    if (b.task === "ticket_reply") {
      const sys = `You help a department administrator draft a short, polite reply to a student's support ticket. Do not invent facts, dates or outcomes, and do not promise that anything will be changed. If "account_facts" are given they were read from the student's account: use them to be specific, for example to say whether a result exists, or that no results have been uploaded for a course at all. Mention only what is relevant. If key details are missing (reg number, course code, session), ask for them. Reply with JSON only: {"reply": string}`;
      return out(await gem(sys, JSON.stringify({ ticket: b.ticket, earlier_replies: b.replies, account_facts: b.context ?? null }).slice(0, 12000), { fast: true, maxOut: 1500 }));
    }

    return out({ error: "Unknown request." });
  } catch (e: any) {
    return out({ error: String(e.message || e), retryable: !!e.retryable });
  }
});

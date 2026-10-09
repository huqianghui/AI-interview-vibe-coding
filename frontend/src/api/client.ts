/**
 * Typed API client for the interview thin slice.
 *
 * The anonymous session token is created once and held in memory + localStorage, then sent as
 * X-Anon-Session on every candidate call (mirrors the backend auth contract). No secrets here —
 * the token is a signed pointer whose authority is the server-side DB row.
 *
 * #102: minting that anon session now requires the candidate's own JWT (Authorization: Bearer) —
 * the backend ties one candidate account to one interview session. ensureSession() sends it; a
 * 401/403 there means the candidate token is missing/invalid/expired or belongs to an admin, so
 * both the candidate token and the (now-orphaned) anon token are dropped and a typed
 * {@link CandidateAuthError} is thrown for the page to react to (back to the login card).
 */
import { clearCandidateToken, getCandidateToken } from "./auth";
import { apiFetch, HttpError, readJson } from "./http";
import { tokenStore } from "./tokenStore";

const TOKEN_KEY = "anon_session_token";
const anonTokenStore = tokenStore("local", TOKEN_KEY);

export interface Question {
  question_id: string;
  prompt: string;
  index: number;
  total: number;
  // True when `prompt` is a pending follow-up (cites the prior answer), not the base question.
  // Voice suppresses its verbatim read for follow-ups — the agent's own auto-response already
  // voices a clarification, so reading it too speaks it twice + duplicates the transcript bubble.
  is_follow_up?: boolean;
  // Follow-ups asked so far on this question — echoed back in `judgeInterview()` so the server can
  // discard a stale judge request (issue #114).
  follow_ups_asked?: number;
}

export interface Interview {
  interview_session_id: string;
  status: string;
  current_question: Question | null;
  // Phase 2 external-brain sub-state ("idle" | "awaiting" | "recovery_required"); null/absent for
  // built-in bank sessions. Drives the "面试官思考中…" (awaiting) and "恢复" (recovery_required)
  // affordances. Vendor-neutral: never names a product.
  external_phase?: string | null;
  // The current external question's speech text (candidate-safe, for the digital human to read).
  // Display text still rides in current_question.prompt. null for bank sessions / no pending Q.
  speech_text?: string | null;
  // True when the interviewer persona has a configured voice — the page then defaults the
  // candidate to the voice + digital-human channel instead of text. Present on start/resume
  // responses; mutation responses leave it false (the page reads it once per interview).
  voice_default?: boolean;
  // Admin-controlled voice silence auto-submit window (from the default persona): 0 ⇒ OFF (the
  // default — the turn advances only on the "I'm done" click), N > 0 ⇒ auto-submit the buffered
  // voice answer after N seconds of silence. Present on start/resume responses; null/absent on
  // mutation responses ("not reported"), so the page latches it per session.
  voice_auto_submit_seconds?: number | null;
  // LINEAR TURNS for this session's voice channel (see `linearTurns` in useInterviewVoice): true ⇒
  // the model gets no generative turn of its own between questions (the digital human only reads
  // the backend's questions; the page never nudges a bare `response.create`, and reads follow-ups
  // verbatim too since nobody else will voice them); false ⇒ the model keeps its turn. External
  // sessions are always true; bank sessions follow the persona's admin-set `bank_turn_mode`.
  // Present on start/resume responses; null/absent on mutation responses ("not reported"), so the
  // page latches it per session.
  voice_linear_turns?: boolean | null;
  // JUDGED sessions (issue #114): seconds of silence (voice) / idle typing (text) after which the
  // page asks the judge via `judgeInterview()`. 0 ⇒ not a judged session (never ask). Present on
  // start/resume; null on mutation responses ("not reported"); latched by the page.
  voice_judge_silence_seconds?: number | null;
  /** Default persona's avatar character id (e.g. "amira"); the stage is painted in that photo's own
   * backdrop colour. Entry points only, null on mutations, latched per session. "" = no avatar. */
  voice_avatar_character?: string | null;
  // Spoken answers are recorded (the microphone only) and kept this many days; the page says so
  // before the voice interview starts.
  audio_recorded?: boolean;
  recording_retention_days?: number;
}

/** `POST /judge` result: what the interviewer should say during this pause, if anything. */
export interface JudgeOut {
  // Nudge-only since 2026-09-28 (owner: the judge paces, it never probes). `follow_up` / `redirect`
  // are retired on the backend and never returned; the page ignores anything else defensively.
  verdict: "wait" | "nudge";
  speech_text: string;
  // The judge_events row behind this verdict; a dry run hands it back for `applyJudge()`.
  event_id: string | null;
  // Always null since 2026-09-28 — the judge never writes a turn, so there is no refreshed
  // interview. Kept in the shape for wire compatibility; nothing reads it.
  interview: Interview | null;
}

/** One rubric item's graded result (F4). Present on scored (non-stub) question entries. */
export interface ScoredItem {
  kind: string; // required | recommended | forbidden
  judgment: string; // met | partially_met | not_met | violated
  weight: number;
  // Advisory forbidden gate (known unvalidated source conflict): when violated it is DISCLOSED but does not cap
  // the outcome. The UI renders such a hit as a neutral disclosure note, not a red failure.
  advisory?: boolean;
  rationale: string;
  answer_quote: string;
  source_quote: string;
  source_page: string | null;
  // The SOP document this item cites, for the report's clickable citation link. When present, the
  // report renders the source label as a link that opens the document via fetchSopDocument; when
  // null/absent it shows plain source text. source_document_name is a display label for the link.
  source_document_id?: string | null;
  source_document_name?: string | null;
  // The SOP sections the item cites, primary first: what the judgment rests on.
  source_sections?: CitedSection[];
}

export interface CitedSection {
  document_id: string;
  document_name: string;
  section: string;
  title: string;
  page: number | null;
}

/** "4.2 Approval" — or the title alone for an unnumbered section ("§3"). */
/** A cited section as a reader sees it: "4.2 Approval", a run of sections (one merged unit)
 *  "1–3 PURPOSE", or the title alone for an unnumbered heading. */
export function sectionName(s: { section: string; title?: string; through?: string }): string {
  const span = s.through ? `${s.section}–${s.through}` : s.section;
  if (span.startsWith("§") && !s.through) return s.title || s.section;
  return `${span} ${s.title ?? ""}`.trim();
}

/** The report's citation text: each cited section with its document, the document named once per
 *  run ("Widget SOP.pdf · 4.2 Approval, 5 Records"); without sections, the legacy page label. */
export function citationText(item: {
  source_sections?: CitedSection[];
  source_page: string | null;
}): string {
  const sections = item.source_sections ?? [];
  if (!sections.length) return item.source_page ?? "";
  const runs: string[] = [];
  let last = "";
  for (const s of sections) {
    const name = sectionName(s);
    if (s.document_name === last) runs[runs.length - 1] += `, ${name}`;
    else runs.push(`${s.document_name} · ${name}`);
    last = s.document_name;
  }
  const page = sections[0].page ? ` · p. ${sections[0].page}` : "";
  return `${runs.join("; ")}${page}`;
}

/**
 * Classification rating. The report headline is one of these three tiers; a confirmed
 * critical error caps a would-be higher outcome down to "Needs Improvement".
 */
export type Outcome = "Meets Expectations" | "Needs Improvement" | "Does Not Meet";

/**
 * One question's result. A scored entry (is_stub false) carries score/grade/items; a stub entry
 * (no checklist authored) carries just judgment/rationale. Both shapes share question_id.
 */
export interface QuestionScore {
  question_id: string;
  /** The question's own text (v0.42.6.0). Present on every row — graded, stub and scoring-failed —
   *  so the report can name the question it is judging instead of labelling it "Question 3". Falls
   *  back to the ordinal when a report predates the field. */
  prompt?: string;
  is_stub?: boolean;
  /** True when this question's grading FAILED outright. The backend has always sent it; nothing
   *  read it, so a question nobody could judge rendered identically to one judged at zero. It is
   *  excluded from the interview score (numerator AND denominator), never scored zero — P7: an
   *  unjudged question is not a badly answered one, and the report must not imply otherwise. */
  scoring_failed?: boolean;
  /** The failure's exception type (e.g. "ScoringIncomplete", "TimeoutError"). Diagnostic, not a
   *  message for the candidate. */
  scoring_error?: string;
  // Scored fields:
  score?: number;
  coverage_pct?: number;
  grade?: string;
  // Per-question classification + whether a critical error capped it, and the question's
  // aggregate weight in the interview-level mean.
  outcome?: Outcome;
  capped?: boolean;
  weight?: number;
  items?: ScoredItem[];
  // Stub fields:
  judgment?: string;
  rationale?: string;
}

/** One "SOP point the checklist may not cover" — a single advisory finding from the opt-in
 * coverage check. `point` is the uncovered requirement in the model's words; `sop_evidence` is a
 * short verbatim span from the SOP passage supporting it. Reference-only: never affects a score. */
export interface SopCoveragePoint {
  point: string;
  sop_evidence: string;
}

/** The opt-in SOP coverage check's findings for ONE question — its uncovered points grouped under
 * the question they belong to. Mirrors the backend's `{question_id, question_text, missing}` shape.
 * Only questions with at least one uncovered point appear. */
export interface SopCoverageQuestion {
  question_id: string;
  question_text: string;
  missing: SopCoveragePoint[];
}

export interface Report {
  interview_session_id: string;
  status: string;
  coverage_pct: number;
  per_question: QuestionScore[];
  is_stub: boolean;
  // F4/F8 scored-report fields (null/empty for the stub path).
  total_score?: number | null;
  grade?: string | null;
  // Interview-level classification rating + whether a confirmed critical error capped it to
  // "Needs Improvement". null for the stub path.
  outcome?: Outcome | null;
  capped?: boolean;
  narrative?: string;
  warnings?: string[];
  // Feature D (opt-in): advisory "SOP points the rubric may not cover", grouped per question.
  // Present only when the candidate ticked the coverage check AND something was found. Never
  // affects the score.
  sop_coverage?: SopCoverageQuestion[] | null;
  /** Questions whose grading failed, so the report can say so instead of quietly averaging fewer
   *  questions than the candidate answered. Present only when there are any. */
  unscored_question_ids?: string[] | null;
}

/** One question + the candidate's finalized answer, for the pre-scoring review screen. Mirrors
 * `AnsweredQuestionOut`. No rubric/score — review happens before scoring (P3). */
export interface AnsweredQuestion {
  question_id: string;
  prompt: string;
  index: number;
  answer_text: string;
}

/** Every answered question in bank order, for the review-before-submit screen. Mirrors `ReviewOut`. */
export interface Review {
  interview_session_id: string;
  status: string;
  answers: AnsweredQuestion[];
}

export type AnswerSource = "text" | "voice" | "verbal_cue";

/**
 * Thrown when minting/refreshing the anon session is rejected because the candidate's own JWT is
 * missing, invalid, expired, or (403) belongs to an admin account — never a candidate. `detail` is
 * the backend's message (verbatim for the 403 "Admin accounts cannot take interviews" case; the
 * 401 detail varies and the page shows its own copy instead). Callers should treat this as "back to
 * the login card", not a generic request failure.
 */
export class CandidateAuthError extends Error {
  status: number;
  detail: string;
  constructor(detail: string, status: number) {
    super(detail);
    this.name = "CandidateAuthError";
    this.status = status;
    this.detail = detail;
  }
}

function getToken(): string | null {
  return anonTokenStore.get();
}

function setToken(token: string): void {
  anonTokenStore.set(token);
}

function clearToken(): void {
  anonTokenStore.clear();
}

/** A candidate call carrying the anon session. A 401 on a cached token self-heals: a token that no
 * longer decodes (backend secret rotated, or its session row is gone) would 401 forever otherwise,
 * so drop it, mint a fresh session and retry ONCE. Never retried without a token. */
async function anonFetch(
  path: string,
  init: RequestInit = {},
  opts: { json?: boolean } = {},
): Promise<Response> {
  const token = getToken();
  try {
    return await apiFetch(path, init, { anonSession: token }, opts);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401 || !token) throw e;
    clearToken();
    await ensureSession();
    return apiFetch(path, init, { anonSession: getToken() }, opts);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return readJson<T>(await anonFetch(path, init));
}

/**
 * Ensure an anonymous candidate session exists; returns the token. Reuses a cached anon token
 * without a network call; otherwise mints one, sending the candidate's own JWT as
 * `Authorization: Bearer` (#102 — the backend requires it and reuses the same session while it's
 * unexpired, so this stays idempotent per user / safe to call again on resume). A 401 (missing/
 * invalid/expired/inactive candidate token) or 403 (an admin account trying to take an interview)
 * clears BOTH the candidate token and the anon token and throws {@link CandidateAuthError}.
 */
export async function ensureSession(): Promise<string> {
  const existing = getToken();
  if (existing) return existing;

  let resp: Response;
  try {
    resp = await apiFetch(
      "/public/candidate/session",
      { method: "POST" },
      { bearer: getCandidateToken() },
    );
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
      clearCandidateToken();
      clearToken();
      throw new CandidateAuthError(e.detail, e.status);
    }
    throw e;
  }
  const body = (await resp.json()) as { session_id: string; token: string; expires_at: string };
  setToken(body.token);
  return body.token;
}

const INTERVIEW_KEY = "interview_session_id";

function getSavedInterviewId(): string | null {
  return typeof localStorage !== "undefined" ? localStorage.getItem(INTERVIEW_KEY) : null;
}

function saveInterviewId(id: string): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(INTERVIEW_KEY, id);
}

function clearSavedInterviewId(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(INTERVIEW_KEY);
}

/**
 * Candidate sign-out (#102): clears the candidate JWT, the anon session token, and the saved
 * interview id — exactly these three keys. The saved interview id is deliberately NOT cleared
 * anywhere else (so logging back in resumes the same in-progress interview via
 * {@link resumeInterview}); it's cleared here because a signed-out candidate must not have their
 * next visit silently resume someone else's session on a shared machine. Callers should tear down
 * any live voice connection BEFORE calling this.
 */
export function signOutCandidate(): void {
  clearCandidateToken();
  clearToken();
  clearSavedInterviewId();
}

/**
 * Called right after a successful candidate login (#102, decision 1A): drop any anon token and
 * saved interview id left in localStorage by whoever used this browser before, so the very next
 * call mints a session bound to THIS account. Resume is not lost — the backend hands the same
 * account its live session back and `start` resumes that account's in-progress interview.
 */
export function resetCandidateSession(): void {
  clearToken();
  clearSavedInterviewId();
}

/** Start an interview — or resume the candidate's in-progress one (the backend reuses it), and
 * persist the id so a page reload can resume via {@link resumeInterview}. */
export async function startInterview(): Promise<Interview> {
  await ensureSession();
  const iv = await request<Interview>("/candidate/interview/start", { method: "POST" });
  saveInterviewId(iv.interview_session_id);
  return iv;
}

/** Resume a persisted in-progress interview on reload, or null if none/over (SPEC F6 edge b).
 * Reads the saved id and GETs its current state; a completed/missing/not-owned interview clears
 * the saved id and returns null so the page falls back to the idle start screen. */
export async function resumeInterview(): Promise<Interview | null> {
  const id = getSavedInterviewId();
  if (!id) return null;
  const token = getToken();
  if (!token) return null;
  try {
    const iv = await request<Interview>(`/candidate/interview/${id}`);
    // An external session can be legitimately in_progress with NO current_question — it's mid-turn
    // (awaiting) or stalled (recovery_required). Resume those on the phase alone; only a bank
    // session (or a completed one) requires a current_question to be worth resuming.
    const externalResumable = iv.external_phase != null && iv.status === "in_progress";
    if (!externalResumable && (iv.status !== "in_progress" || !iv.current_question)) {
      clearSavedInterviewId();
      return null;
    }
    return iv;
  } catch {
    clearSavedInterviewId(); // 404 (not found / not owned) → nothing to resume
    return null;
  }
}

export async function submitAnswer(
  interviewId: string,
  text: string,
  source: AnswerSource = "text",
): Promise<Interview> {
  return request<Interview>(`/candidate/interview/${interviewId}/answer`, {
    method: "POST",
    body: JSON.stringify({ text, source }),
  });
}

/**
 * Re-drive a stalled external-brain turn — the candidate's "恢复" (recover) action. Only meaningful
 * when external_phase is "recovery_required" (or an "awaiting" turn stranded by a crash). Safe to
 * call repeatedly: the backend re-sends the same committed state + pending answer, never
 * double-advancing. A bank session (or nothing to recover) 409s. No-op for built-in bank mode.
 */
export async function recoverInterview(interviewId: string): Promise<Interview> {
  return request<Interview>(`/candidate/interview/${interviewId}/recover`, { method: "POST" });
}

/**
 * Ask the judge whether the interviewer should say something DURING the candidate's pause (issue
 * #114). Never blocks or submits anything. `question_id` / `follow_ups_asked` let the server drop a
 * stale request (the question advanced meanwhile) without spending an LLM call.
 */
export async function judgeInterview(
  interviewId: string,
  body: {
    question_id: string;
    follow_ups_asked: number;
    draft_text: string;
    trigger: "voice_silence" | "text_idle";
    // Speculative prefetch (D17): decide now, write nothing; apply later with `applyJudge()`.
    dry_run?: boolean;
  },
): Promise<JudgeOut> {
  return request<JudgeOut>(`/candidate/interview/${interviewId}/judge`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Deliver a dry-run verdict once the pause has actually lasted (D17). Stale-safe and idempotent on
 * the server: an advanced question, a moved follow-up count, a spent slot, or a re-apply all come
 * back as `wait` and write nothing.
 */
export async function applyJudge(
  interviewId: string,
  body: { event_id: string; question_id: string; follow_ups_asked: number },
): Promise<JudgeOut> {
  return request<JudgeOut>(`/candidate/interview/${interviewId}/judge/apply`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Abandon the candidate's LIVE interview and start a fresh one (the "重新开始 / Restart" button,
 * v0.38.3.0). The old session persists as `abandoned` (kept for the record, never resumed or
 * scored); the response IS the new session, whose id replaces the saved one so a reload resumes the
 * fresh interview. Only an in_progress interview can be restarted (409 otherwise).
 */
export async function restartInterview(interviewId: string): Promise<Interview> {
  const iv = await request<Interview>(`/candidate/interview/${interviewId}/restart`, {
    method: "POST",
  });
  saveInterviewId(iv.interview_session_id);
  return iv;
}

/**
 * Score the interview and return the report. `sopCoverageCheck` (feature D, default off) opts into
 * the advisory "SOP original-text coverage" audit — an extra reference-only pass that never changes
 * a score. When false we still send the body so the flag is explicit; the backend also accepts none.
 */
export async function getReport(
  interviewId: string,
  sopCoverageCheck = false,
): Promise<Report> {
  return request<Report>(`/candidate/interview/${interviewId}/report`, {
    method: "POST",
    body: JSON.stringify({ sop_coverage_check: sopCoverageCheck }),
  });
}

/** One NDJSON progress line from the streaming report endpoint: `done` answers graded out of
 * `total`, emitted as each grading call finishes. */
export interface ScoringProgress {
  done: number;
  total: number;
  question_id: string;
}

/**
 * Progress of the OPT-IN SOP coverage audit, which runs after every answer is graded (v0.45.0.0).
 *
 * Its own counter, because `total` here is NOT the question count: only a question with a checklist
 * AND a linked SOP passage costs a model round-trip, so this denominator is usually smaller. The
 * audit used to emit nothing, which is why the scoring screen sat at "9 of 9" for minutes.
 */
export interface CoverageProgress {
  done: number;
  total: number;
  question_id?: string;
}

/**
 * Streaming variant of {@link getReport}: resolves with the same report, but invokes `onProgress`
 * once per question as the backend grades it — REAL progress for the scoring screen instead of the
 * faked numerator (each grading call is an LLM round-trip taking seconds).
 *
 * Reads NDJSON off a POST fetch (EventSource can't POST or carry X-Anon-Session). Any in-band
 * `{"type":"error"}` line or a stream that ends without a report rejects, so callers can fall back
 * to the batch endpoint.
 */
export async function getReportStream(
  interviewId: string,
  sopCoverageCheck = false,
  onProgress?: (p: ScoringProgress) => void,
  onCoverage?: (p: CoverageProgress) => void,
): Promise<Report> {
  const resp = await anonFetch(`/candidate/interview/${interviewId}/report/stream`, {
    method: "POST",
    body: JSON.stringify({ sop_coverage_check: sopCoverageCheck }),
  });
  if (!resp.body) throw new Error("scoring stream has no body");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let report: Report | null = null;

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "progress" && onProgress) {
      onProgress(event as ScoringProgress);
    } else if (event.type === "coverage" && onCoverage) {
      onCoverage(event as CoverageProgress);
    } else if (event.type === "report") {
      report = event.report as Report;
    } else if (event.type === "error") {
      throw new Error(String(event.detail ?? "scoring failed"));
    }
    // Any other type (today: "ping", "question_error") is ignored on purpose. A ping exists only to
    // put bytes on the wire so the connection does not idle out; it carries nothing to show.
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the trailing partial line
    for (const line of lines) handleLine(line);
  }
  handleLine(buffer); // a final line may lack the trailing newline

  if (!report) throw new Error("scoring stream ended without a report");
  return report;
}

/** Fetch every answered question + answer in bank order for the pre-scoring review screen
 * (requirement 4). Backend-sourced so it survives a reload and matches what gets scored. Only
 * valid once the interview is completed/scored (409 otherwise). */
export async function getReview(interviewId: string): Promise<Review> {
  return request<Review>(`/candidate/interview/${interviewId}/review`);
}

/**
 * Fetch a cited SOP source document and return a blob object URL the caller can open in a new tab
 * (the report's clickable citations). We fetch bytes with the X-Anon-Session header rather than
 * linking the endpoint directly, because the anon session is a header — not a cookie — so a naked
 * `<a href>` navigation would be unauthenticated (401). The blob URL also keeps the session token
 * out of the address bar and lets the browser preview a PDF/text inline. Callers should
 * URL.revokeObjectURL the returned url when done. Throws on a non-2xx (e.g. 404 for an uncited id).
 */
export async function fetchSopDocument(
  interviewId: string,
  documentId: string,
): Promise<string> {
  const resp = await anonFetch(
    `/candidate/interview/${interviewId}/sop/${encodeURIComponent(documentId)}`,
    {},
    { json: false },
  );
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

// ── Interview history (#187) ───────────────────────────────────────────

export type HistoryStatus = "created" | "in_progress" | "completed" | "scored" | "abandoned";

/** One past (or live) interview in a history list. Mirrors `InterviewHistoryItem`. */
export interface InterviewHistoryItem {
  id: string;
  status: HistoryStatus;
  started_at: string | null;
  completed_at: string | null;
  // null on interviews started before #187 (nothing was recorded) or when the row was deleted.
  persona_name: string | null;
  bank_name: string | null;
  // From the last scoring run; null until scored.
  total_score: number | null;
  outcome: Outcome | null;
  has_report: boolean;
}

/** One turn of an interview's transcript. Mirrors `TranscriptTurn`. */
export interface TranscriptTurn {
  turn_index: number;
  role: "interviewer" | "candidate";
  turn_kind: "main" | "follow_up";
  content: string;
  created_at: string;
}

/** One interview with its saved report (null until scored) and transcript. Mirrors
 * `InterviewDetail`. */
export interface InterviewDetail {
  item: InterviewHistoryItem;
  report: Report | null;
  transcript: TranscriptTurn[];
  /** Admin read only: an admin-started scoring run is still going. */
  scoring?: boolean;
  /** Admin read only: the bank version the interview was asked and scored from. */
  bank_version_no?: number | null;
}

/** The signed-in candidate's interviews, newest first, every status. */
export async function listMyInterviews(): Promise<InterviewHistoryItem[]> {
  return request<InterviewHistoryItem[]>("/candidate/interviews");
}

export async function getMyInterview(interviewId: string): Promise<InterviewDetail> {
  return request<InterviewDetail>(`/candidate/interviews/${interviewId}`);
}

/** {@link fetchSopDocument} for a report opened from the history: the same citation rule, but an
 * interview from an earlier login is still the candidate's. */
export async function fetchMySopDocument(interviewId: string, documentId: string): Promise<string> {
  const resp = await anonFetch(
    `/candidate/interviews/${interviewId}/sop/${encodeURIComponent(documentId)}`,
    {},
    { json: false },
  );
  return URL.createObjectURL(await resp.blob());
}

export const _internal = { TOKEN_KEY, getToken, setToken };

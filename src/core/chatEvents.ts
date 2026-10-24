/**
 * Chat skin — the small pure helpers the usage bar and the tool lines share (no electron, no fs):
 *  (a) parseStatuslinePayload — read the payload Claude Code's statusline dumps to disk;
 *  (b) mergeStatus — build the usage bar's ChatStatus from one or more sources;
 *  (c) summarizeTool — one line saying what a tool call is about.
 * The conversation itself comes from the transcript (core/transcriptChat.ts), not from here.
 *
 * THE RULE FOR EVERY NUMBER HERE: an absent field stays `undefined`. A bar that shows "0%" because
 * a field was missing is a fabricated reading, and the operator would trust it. Nothing in this
 * file defaults a percentage to 0.
 */

// ── the contract (shared by main, preload and renderer) ─────────────────────

export interface ChatStatus {
  fiveHourPct?: number;
  sevenDayPct?: number;
  contextPct?: number;
  model?: string;
  effort?: string;
  /** Where the fields came from: the live session, the statusline file, or a blend of both. */
  source: 'sdk' | 'file' | 'mixed';
}

/** A ChatStatus without its provenance — what one source can contribute on its own. */
export type StatusFields = Omit<ChatStatus, 'source'>;

// ── small, defensive readers ────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A finite number, or undefined. Numeric strings are NOT accepted: a payload that stringifies a
 *  percentage is a payload we do not understand, and guessing is how a bar lies. */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

/** First defined value among dotted paths — the same idea as the statusline hook's
 *  `first_present`, because the payload's field names have moved between Claude Code versions. */
function firstPresent(o: unknown, paths: string[]): unknown {
  for (const p of paths) {
    let cur: unknown = o;
    for (const k of p.split('.')) {
      if (!isObj(cur)) { cur = undefined; break; }
      cur = cur[k];
    }
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}

// ── (a) the statusline payload ──────────────────────────────────────────────

/**
 * Read `~/.claude/statusline-payload.json` (already read to a string, or parsed). Field paths and
 * fallbacks mirror hooks/statusline.py, which is the only place the payload's shape is verified
 * against a live Claude Code. Garbage in → `{}` out, never a throw, never an invented zero.
 */
export function parseStatuslinePayload(input: unknown): StatusFields {
  let d: unknown = input;
  if (typeof input === 'string') {
    try { d = JSON.parse(input); } catch { return {}; }
  }
  if (!isObj(d)) return {};

  // context: the reported percentage first; else derive it from tokens and the window size
  let context = num(firstPresent(d, [
    'context_window.used_percentage', 'context_window.percentage_used',
    'context.percentage_used', 'context.usage_pct',
  ]));
  if (context === undefined) {
    const used = num(firstPresent(d, ['context_window.total_input_tokens', 'context.tokens_used']));
    const size = num(firstPresent(d, ['context_window.context_window_size', 'context.window_size']));
    if (used !== undefined && size !== undefined && size > 0) context = (used / size) * 100;
  }

  const five = num(firstPresent(d, [
    'rate_limits.five_hour.used_percentage', 'rate_limits.five_hour.percent_used',
    'session_5h.used_percentage', 'session_5h.usage_pct',
  ]));
  const seven = num(firstPresent(d, [
    'rate_limits.seven_day.used_percentage', 'rate_limits.seven_day.percent_used',
    'rate_limits.weekly.used_percentage', 'weekly.usage_pct',
  ]));

  // `model` is an object ({id, display_name}) in current payloads and a bare string in older ones
  const m = d.model;
  const model = str(firstPresent(d, ['model.display_name', 'model.id'])) ?? str(m);
  const effort = str(firstPresent(d, ['effort.level', 'effort_level', 'effortLevel', 'model.effort_level']));

  const out: StatusFields = {};
  if (five !== undefined) out.fiveHourPct = clampPct(five);
  if (seven !== undefined) out.sevenDayPct = clampPct(seven);
  if (context !== undefined) out.contextPct = clampPct(context);
  if (model !== undefined) out.model = model;
  if (effort !== undefined) out.effort = effort;
  return out;
}

// ── (b) merging sources ─────────────────────────────────────────────

const FIELDS = ['fiveHourPct', 'sevenDayPct', 'contextPct', 'model', 'effort'] as const;

/**
 * The live session wins field by field; the file fills what the session cannot know (rate limits
 * and effort are account/CLI facts the SDK stream does not carry). The file is the LAST payload
 * written by ANY Claude Code session on the machine, so for model and context it can describe a
 * different conversation entirely — which is why it is only ever the fallback.
 * `source` says what actually contributed, so the bar can be honest about a stale reading.
 */
export function mergeStatus(sdk: StatusFields | undefined, file: StatusFields | undefined): ChatStatus {
  const out: ChatStatus = { source: sdk ? 'sdk' : 'file' };
  let fromSdk = false;
  let fromFile = false;
  for (const f of FIELDS) {
    const a = sdk?.[f];
    const b = file?.[f];
    if (a !== undefined) { (out as unknown as Obj)[f] = a; fromSdk = true; }
    else if (b !== undefined) { (out as unknown as Obj)[f] = b; fromFile = true; }
  }
  if (fromSdk && fromFile) out.source = 'mixed';
  else if (fromSdk) out.source = 'sdk';
  else if (fromFile) out.source = 'file';
  return out;
}

// ── (c) one line per tool call ──────────────────────────────────────────────

/** One line saying what a tool call is about — enough to recognise it, not to audit it. */
export function summarizeTool(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) { const v = str(i[k]); if (v) return v; }
    return undefined;
  };
  let s: string | undefined;
  switch (name) {
    case 'Bash': case 'PowerShell': s = pick('command'); break;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': s = pick('file_path', 'notebook_path', 'path'); break;
    case 'Glob': case 'Grep': s = pick('pattern'); break;
    case 'WebFetch': s = pick('url'); break;
    case 'WebSearch': s = pick('query'); break;
    case 'Skill': s = pick('skill'); break;
    case 'Agent': case 'Task': s = pick('description', 'prompt'); break;
    default: break;
  }
  if (s === undefined) {
    // an unknown tool: its first string argument is the most informative thing we can show
    for (const v of Object.values(i)) { const t = str(v); if (t) { s = t; break; } }
  }
  if (s === undefined) { try { s = JSON.stringify(input) ?? ''; } catch { s = ''; } }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}

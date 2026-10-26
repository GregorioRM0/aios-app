/**
 * Chat skin — read the assistant reply that is being WRITTEN right now off the TUI screen.
 * PURE: it takes the plain text of the visible terminal (the same shape `detectTuiPrompt` gets) and
 * returns the text of the reply in progress, or null. No electron, no fs, no pty.
 *
 * WHY THIS EXISTS. The transcript only records a message when the model has finished it, so the chat
 * view shows nothing for the seconds a long answer takes to arrive, while the terminal shows it word
 * by word. The screen is the only place the partial reply exists. The chat view draws it as a
 * PROVISIONAL bubble and, when the finished message lands in the transcript, replaces the bubble by
 * the real one: the transcript stays the single source of truth, this is only a preview of it.
 * `sameMessage` is how the renderer decides that a transcript message IS the one that was previewed
 * (so the bubble is swapped, not duplicated).
 *
 * WHAT THE SCREEN LOOKS LIKE (hand-checked against the shipped CLI's strings, not copied from any
 * session): older turns scroll up as `> what the operator typed` and `⏺ …` blocks; the reply in
 * progress is the LAST `⏺` block, its text indented two columns under the bullet and re-wrapped to
 * the terminal width; below it a spinner (`✻ Thinking…`, `· Pondering… (12s · esc to interrupt)`),
 * then the input box (`╭─╮ │ > … │ ╰─╯`, or a `─────` rule above and below), then footer hints
 * (`? for shortcuts`, `auto-accept edits on`) and whatever status line the operator configured.
 *
 * WHAT COUNTS AS "STREAMING". All three must hold, because each alone is also true of a finished
 * screen: (1) the spinner (or an "esc to interrupt" hint) is on screen — an idle screen keeps the
 * last answer visible but has no spinner; (2) the LAST block is a text block — a `⏺ Tool(…)` row
 * after the text means the text is complete and the transcript has it, and a screen that ends in a
 * tool row has no reply in progress; (3) no dialog is up (`detectTuiPrompt`), because a dialog
 * replaces the spinner and the box and what is above it is not being written any more.
 *
 * KNOWN LIMITS, all of them things the screen cannot say:
 *  - the TUI paints MARKDOWN RENDERED: `**bold**` markers, `#` heading marks, code fences and the
 *    language tag are gone, links lose their URL, tables are drawn with box characters. The text
 *    returned is what the TUI shows, not the model's source; `sameMessage` compares on letters and
 *    digits only for exactly this reason. Partial markdown (an unclosed `**`, half a table) is
 *    returned as painted.
 *  - re-wrapped lines are rejoined by a heuristic: a line that starts a list item, a table row, a
 *    quote or is indented as code starts a new line, anything else is a continuation. A WRAPPED CODE
 *    LINE is therefore split in two, and a hard line break inside a paragraph is lost (markdown folds
 *    it into a space anyway).
 *  - only the visible rows exist: a reply taller than the window has lost its head (`headCut`), and
 *    nothing here can recover it. The head is also what `anchor` is built from, so a headCut reply
 *    has an empty anchor and must be matched with `sameMessage(…, { headCut: true })`.
 *  - the last word may be half-written and the last line is whatever was painted so far.
 *  - an operator-configured status line, if the caller keeps rows below the input box, is dropped
 *    only when the input box itself is found; without the box it can leak in as text.
 *  - text before a tool call in the same turn is deliberately NOT returned (see 2 above).
 *  - the wording of the spinner, the glyphs and the footers are the CLI's and change between versions.
 */
import { stripAnsi, BORDER, detectTuiPrompt } from './tuiPrompt';

export interface StreamingReply {
  /** The reply as painted so far, rewrapped, without bullet, spinner, input box or footers. */
  text: string;
  /**
   * A stable signature of the BEGINNING of the block: its first words, lowercased, letters and digits
   * only, joined by single spaces. It stops changing once the block has `anchorWords` words, so the
   * renderer can key the provisional bubble by it while the text grows. Empty when `headCut`.
   */
  anchor: string;
  /** True when the opening bullet is not on screen (the reply is taller than the window). */
  headCut: boolean;
}

export interface ExtractOptions {
  /** Words in the anchor. Default `STREAM_ANCHOR_WORDS`. */
  anchorWords?: number;
  /** Require the spinner to be visible (default true). False reads the last text block of ANY screen. */
  requireActive?: boolean;
}

export const STREAM_ANCHOR_WORDS = 6;

/** A row made only of box-drawing characters: a border or rule of the input box. */
const isRule = (l: string): boolean => l.trim() !== '' && l.replace(BORDER, '').trim() === '';
/** The input box's prompt row: `> text`, `❯ text`, optionally between side borders. */
const PROMPT_ROW = /^(?:[│┃] ?|\s?)[>❯](?: |$)/;
/** A row the operator typed, echoed into the scrollback: the prompt glyph flush left. */
const ECHO_ROW = /^\s{0,1}[>❯]\s+\S/;
const BULLET = /^\s{0,1}[⏺●]\s?(.*)$/;
const THINKING = /^\s{0,1}∴/;
/** `Bash(npm test)`, `Update(src/a.ts)`, `Web Search("x")`, `server - tool (MCP)(arg)`: a name glued to `(`. */
const TOOL_HEAD = /^(?:[A-Z][\w.:-]*(?: [A-Z][\w.:-]*){0,2}|[a-z][\w.-]*(?: - [\w.-]+)?)(?: \(MCP\))?\(/;
/** The collapsed summaries the TUI prints for read-only tools: `Searched for 2 patterns (ctrl+o to expand)`. */
const TOOL_SUMMARY = /\(ctrl\+o to expand\)|^(?:Read|Searched for|Listed|Wrote|Edited|Updated|Created|Fetched) \d+/;
const RESULT_ROW = /^\s*⎿/;

/** Spinner: a glyph, a short phrase ending in an ellipsis, optionally `(12s · ↓ 1.2k tokens · esc to interrupt)`. */
const SPINNER = /^\s{0,1}[✻✽✶✳✢·∗✺]\s+\S+(?:\s\S+){0,3}\s?(?:…|\.\.\.)(?:\s*\([^)]*\))?\s*$/;
/** `*` is also a plain list bullet, so it only counts as a spinner with the parenthetical the spinner carries. */
const SPINNER_STAR = /^\s{0,1}\*\s+\S+(?:\s\S+){0,3}\s?(?:…|\.\.\.)\s*\([^)]*(?:esc|tokens|\d+s)[^)]*\)\s*$/;
const ESC_HINT = /^\s*\(?esc to interrupt\)?\s*$/i;
/** The line the TUI leaves after a turn ends (`✻ Worked for 1m 3s`): noise, and proof the turn is over. */
const DONE_MARK = /^\s{0,1}[✻✽✶✳✢·]\s+\S+ for \d/;
/** Footer and mode hints under the input box. Anchored: a sentence in an answer must not match. */
const FOOTER_NOISE: RegExp[] = [
  // the hint is followed by a wide gap and the status columns, or ends the line; a sentence that merely starts with it is text
  /^\s*\?\s+for shortcuts(?:\s{2,}.*)?$/i,
  /^\s*⏵⏵?\s/,
  /^\s*[⏸⏹]?\s*(?:auto-accept edits|accept edits|bypass permissions|plan mode)\b.*$/i,
  /\(shift\+tab to cycle\)\s*$/i,
  /^\s*(?:ctrl\+[a-z] to (?:expand|hide|show)[\w ]*|press ctrl-?c again to exit|\d+ (?:shells?|tasks?|agents?) running.*)\s*$/i,
];

const isSpinner = (l: string): boolean => SPINNER.test(l) || SPINNER_STAR.test(l);
const isNoise = (l: string): boolean => isSpinner(l) || ESC_HINT.test(l) || DONE_MARK.test(l) || FOOTER_NOISE.some((r) => r.test(l));

type ItemType = 'echo' | 'text' | 'tool' | 'thinking' | 'other';
interface Item { type: ItemType; lines: string[]; orphan?: boolean }

const indentOf = (l: string): number => l.length - l.trimStart().length;
const LIST_ITEM = /^\s*(?:[•◦▪▸\-*]|\d{1,3}[.)])\s+\S/;
const TABLE_ROW = /^\s*[│┃┌┐└┘├┤┬┴┼─]/;
const QUOTE_ROW = /^\s*(?:▎|▌|>)\s?/;

/**
 * Rejoin what the terminal wrapped. `rows` are the block's content rows with the two-column bullet
 * gutter already removed. Paragraphs (blank-row separated) stay apart; inside one, a row continues
 * the previous unless it starts a list item, a table row, a quote, or is indented like code.
 */
function reflow(rows: string[]): string {
  const paragraphs: string[][] = [[]];
  for (const r of rows) {
    if (r.trim() === '') { if (paragraphs[paragraphs.length - 1].length) paragraphs.push([]); continue; }
    paragraphs[paragraphs.length - 1].push(r);
  }
  const out: string[] = [];
  for (const para of paragraphs) {
    if (!para.length) continue;
    const lines: string[] = [];
    let cur = '';
    let inList = false;
    for (const r of para) {
      const t = r.trim();
      if (cur === '') { cur = indentOf(r) >= 2 ? r.trimEnd() : t; inList = LIST_ITEM.test(r); continue; }
      if (LIST_ITEM.test(r) || TABLE_ROW.test(r) || QUOTE_ROW.test(r) || (indentOf(r) >= 2 && !inList)) {
        lines.push(cur); cur = indentOf(r) >= 2 ? r.trimEnd() : t; inList = LIST_ITEM.test(r);
      } else cur += ' ' + t;
    }
    if (cur) lines.push(cur);
    out.push(lines.join('\n'));
  }
  return out.join('\n\n').replace(/[▍▌█▏]+\s*$/, '').trimEnd();
}

/** Letters and digits, lowercased: what survives both the TUI's markdown rendering and the model's source. */
export function normalizeForMatch(s: string): string {
  return stripMarkdownSyntax(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Drop the markdown the TUI does not paint as text: fence lines (and their language tag) and link targets. */
function stripMarkdownSyntax(s: string): string {
  return s
    .replace(/^\s*(?:```|~~~).*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<https?:[^>]*>/g, ' ');
}

/** The first `n` words as a lowercase, letters-and-digits signature. */
export function anchorOf(text: string, n = STREAM_ANCHOR_WORDS): string {
  const words = stripMarkdownSyntax(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.slice(0, n).join(' ');
}

/**
 * Does the finished transcript message `finalText` correspond to the provisional bubble `provisional`?
 * The provisional text is a PREFIX of the final one (it was cut mid-stream), compared on letters and
 * digits so that markdown the TUI rendered away, rewrapping and bullets do not matter. With
 * `headCut` the provisional is the TAIL of what was written (its head scrolled off), so a substring
 * match is used instead, with a minimum length so a short fragment cannot match everything.
 */
export function sameMessage(provisional: string, finalText: string, opts: { headCut?: boolean } = {}): boolean {
  const a = normalizeForMatch(provisional);
  const b = normalizeForMatch(finalText);
  if (!a || !b) return false;
  if (opts.headCut) return a.length >= 12 && b.includes(a);
  return b.startsWith(a);
}

/**
 * Find the input box, if the screen shows one at the bottom, and return the row where it starts
 * (its top border when it has one), else -1. The box is the LAST prompt row, but a prompt row is
 * also how an earlier message of the operator's is echoed into the scrollback, so it only counts
 * as the box when what follows is what a box has under it: a bottom border and footers, never a
 * `⏺` block. That is also why a reply containing a table (more border rows) is not eaten.
 */
function composerStart(rows: string[]): number {
  let p = -1;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 24); i--) if (PROMPT_ROW.test(rows[i])) { p = i; break; }
  if (p < 0) return -1;
  const rest = rows.slice(p + 1);
  if (rest.some((l) => BULLET.test(l) || ECHO_ROW.test(l))) return -1;
  const bottom = rest.findIndex(isRule);
  if (bottom >= 0) {
    // draft lines before the bottom border (a multi-line message), then footers and, possibly, the
    // operator's own status line — a few rows, never a screenful
    if (bottom > 8 || rest.slice(bottom + 1).filter((l) => l.trim() !== '' && !isRule(l) && !isNoise(l)).length > 3) return -1;
  } else if (!rest.every((l) => l.trim() === '' || isNoise(l))) return -1;
  let c = p;
  while (c - 1 >= 0 && isRule(rows[c - 1])) c--;
  return c;
}

/**
 * The assistant reply being written on this screen, or null when there is none (idle screen, a dialog
 * up, only tools running, nothing painted yet). See the header for what "being written" requires.
 */
export function extractStreaming(screen: string, opts: ExtractOptions = {}): StreamingReply | null {
  if (!screen) return null;
  if (detectTuiPrompt(screen)) return null;
  const all = stripAnsi(screen).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));

  // 1. cut the input box and everything under it
  const c = composerStart(all);
  let rows = c >= 0 ? all.slice(0, c) : all.slice();

  // 2. the spinner marks a live turn and the end of the reply: whatever sits under it (a todo panel,
  // a tip, a queued message) is not text of the reply
  let s = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (isSpinner(rows[i]) || ESC_HINT.test(rows[i])) { s = i; break; }
  if (s < 0 && (opts.requireActive ?? true)) return null;
  if (s >= 0) rows = rows.slice(0, s);

  // 3. group the rest into blocks
  const items: Item[] = [];
  let cur: Item | null = null;
  for (const row of rows) {
    if (isNoise(row)) continue;
    if (row.trim() === '') { cur?.lines.push(''); continue; }
    if (ECHO_ROW.test(row)) { cur = { type: 'echo', lines: [row] }; items.push(cur); continue; }
    if (THINKING.test(row)) { cur = { type: 'thinking', lines: [row] }; items.push(cur); continue; }
    const b = BULLET.exec(row);
    if (b) {
      const body = b[1];
      const type: ItemType = TOOL_HEAD.test(body) || TOOL_SUMMARY.test(body) ? 'tool' : 'text';
      cur = { type, lines: [body] }; items.push(cur); continue;
    }
    if (RESULT_ROW.test(row)) { if (cur?.type !== 'tool') { cur = { type: 'tool', lines: [] }; items.push(cur); } cur.lines.push(row); continue; }
    if (!cur) {
      // content with no opener above it: the head of a tall reply scrolled off. Only a row at the text
      // gutter qualifies; deeper rows are as likely to be a tool's output.
      if (indentOf(row) >= 2 && indentOf(row) <= 3) { cur = { type: 'text', lines: [row.trimStart()], orphan: true }; items.push(cur); }
      continue;
    }
    if (cur.type === 'text' && indentOf(row) < 2) { cur = { type: 'other', lines: [row] }; items.push(cur); continue; }   // flush-left output ends the block
    cur.lines.push(row);
  }

  // 4. the reply in progress is the last block, and only if it is text
  const last = items[items.length - 1];
  if (!last || last.type !== 'text') return null;
  const body = last.lines.map((l, i) => (i === 0 ? l.trim() : l.slice(Math.min(2, indentOf(l)))));
  const text = reflow(body);
  if (!text) return null;
  const n = opts.anchorWords ?? STREAM_ANCHOR_WORDS;
  return { text, anchor: last.orphan ? '' : anchorOf(text, n), headCut: !!last.orphan };
}

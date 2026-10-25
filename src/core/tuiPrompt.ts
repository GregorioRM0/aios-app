/**
 * Chat skin — recognise when the `claude` TUI is waiting on a dialog that only the terminal can
 * answer (a permission request, the folder-trust prompt, a /model picker, an AskUserQuestion, a
 * numbered menu). PURE: it takes plain text and returns a verdict, so it is testable without a pty.
 *
 * WHY THIS EXISTS. The chat view reads the transcript, and the transcript only learns about a tool
 * AFTER the operator allows it. While the TUI sits on "Do you want to proceed?", the transcript
 * shows a tool_use with no result and says nothing else; the only place the question exists is the
 * screen. So the chat view watches the tail of the pty output too, purely to know "the terminal is
 * asking something" and send the operator there. It never answers for them.
 *
 * HOW IT STAYS HONEST. A wrong "yes, there's a dialog" sends the operator to a terminal for nothing;
 * a wrong "no" leaves a blocked session looking idle. The first is cheaper, but ordinary answers
 * are full of numbered lists and sentences like "Do you want to proceed?", so every verdict needs
 * STRUCTURE, not wording: a numbered option list with the TUI's selection cursor (❯), sitting at
 * the very end of the screen (a dialog is the last thing painted; anything printed after it means
 * it was dismissed), plus a recogniser or a footer hint that only the TUI prints. Strings were
 * checked against the shipped CLI binary: "Do you want to proceed?", "tell Claude what to do
 * differently", "Yes, and don't ask again for", "Yes, I trust this folder", "Quick safety check",
 * "Select model", "Type something", "Chat about this", "Enter to select", "Esc to cancel".
 *
 * KNOWN LIMITS: wording is the CLI's and changes between versions (English only, as the TUI is);
 * a dialog taller than the window the caller keeps loses its question line (the kind then falls
 * back to 'select'); and 'other' is intentionally narrow.
 */

export type TuiPromptKind = 'permission' | 'trust' | 'select' | 'question' | 'model' | 'other';
export interface TuiPrompt { kind: TuiPromptKind; hint: string }

/**
 * Strip terminal control sequences, keeping the text. CSI cursor-forward (`ESC[nC`) becomes spaces
 * because Ink positions words that way and joining them would glue "Yes," to "and". Everything
 * else (colours, cursor moves, OSC titles/hyperlinks, charset selects, bare C0 controls except
 * \n \r \t) is dropped.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n) || 1, 40)))
    // Ink also places words with an ABSOLUTE column (`ESC[<n>G`); dropping it glues the words
    // ("Quicksafetycheck") and no wording-based recogniser can match. A space is enough: the
    // lines are trimmed and the column itself carries no meaning here.
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')                // OSC … BEL | ST
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')                         // CSI
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')                        // DCS / SOS / PM / APC
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '')                           // charset selection
    .replace(/\x1b[@-Z\\-_=>78]/g, '')                               // two-char escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// box-drawing and block characters Ink draws dialogs with
const BORDER = /[│┃║╭╮╰╯┌┐└┘─━═╌╍┄┅]/g;

/** `❯ 1. Yes`, `  2. No`, `› 3. …` — group 1 is the cursor (if any), 2 the number, 3 the label. */
const OPTION = /^\s*([❯›>])?\s*(\d{1,2})[.)]\s+(\S.*)$/;
/** `❯ label` with no number: the cursor of an unnumbered menu. */
const CURSOR_LINE = /^\s*[❯›]\s+\S/;
const FOOTER =/(Enter to (?:select|confirm|submit|continue)|Esc to (?:cancel|exit|close|go back)|to navigate|Tab\/Arrow keys|Press Enter to continue)/i;

const TRUST = /(Quick safety check|trust (?:this|the files in this) folder|Do you trust the files|Yes, I trust)/i;
const MODEL = /(Select model|Switch between Claude models)/i;
// AskUserQuestion always adds free-text / discuss options; its header chips are ☐ ☒ ✔ checkboxes
const QUESTION = /(Type something|Chat about this|^\s*[←→]?\s*[☐☒]\s)/m;
const PERMISSION = /(Do you want to |Would you like to proceed|tell Claude what to do differently|Yes, and don't ask again|Yes, allow all edits|Yes, during this session)/i;
// 'other': a prompt that is not a menu but still waits on a keypress
const OTHER = /(Press Enter to continue|\(y\/n\)\s*$|\[y\/N\]\s*$|\[Y\/n\]\s*$)/i;

/** Only the lines at the very end of the screen can be a live dialog. */
const TAIL_LINES = 40;
/** The last option must be within this many non-empty lines of the end. A dialog prints at most a
 *  description and a footer after its last option; more than that means output moved on past it. */
const OPTION_REACH = 5;

const HINT_MAX = 160;
const clip = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > HINT_MAX ? t.slice(0, HINT_MAX - 1) + '…' : t;
};

function cleanLines(screen: string): string[] {
  return stripAnsi(screen)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(BORDER, ' ').replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
}

/**
 * `screenText`: the recent output of the pty (ANSI may still be present; it is stripped here).
 * Returns the kind of dialog the TUI is showing at the END of that text, or null.
 */
export function detectTuiPrompt(screenText: string): TuiPrompt | null {
  if (!screenText) return null;
  const all = cleanLines(screenText);
  if (all.length === 0) return null;
  const lines = all.slice(-TAIL_LINES);
  const n = lines.length;

  // 1. the option list: consecutive numbered lines, at least two, one carrying the cursor
  let last = -1;
  for (let i = n - 1; i >= 0; i--) if (OPTION.test(lines[i])) { last = i; break; }

  if (last >= 0 && n - 1 - last <= OPTION_REACH) {
    // walk up over the block: numbering must descend by one per option going up (so an older list
    // printed above the dialog is not swallowed), with a few indented description lines between them
    let first = last;
    const nums: number[] = [];
    let gap = 0;
    for (let i = last; i >= 0; i--) {
      const m = OPTION.exec(lines[i]);
      if (m) {
        const v = Number(m[2]);
        if (nums.length && v !== nums[0] - 1) break;
        first = i; nums.unshift(v); gap = 0;
        if (v === 1) break;
      } else if (++gap > 4) break;
    }
    const block = lines.slice(first, last + 1);
    const cursor = block.some((l) => { const m = OPTION.exec(l); return !!m && !!m[1]; });
    const sequential = nums.length >= 2 && nums.every((v, i) => i === 0 || v === nums[i - 1] + 1);
    const withBelow = lines.slice(first, n).join('\n');
    // context: what the TUI prints around a dialog (title + question above, footer below)
    const above = lines.slice(Math.max(0, first - 8), first).join('\n');
    const ctx = `${above}\n${withBelow}`;

    if (cursor && sequential) {
      const question = [...lines.slice(Math.max(0, first - 8), first)].reverse().find((l) => /\?\s*$/.test(l));
      const hintOf = (fallback: string): string => clip(question ?? lines[first - 1] ?? fallback);
      if (TRUST.test(ctx)) return { kind: 'trust', hint: hintOf('Trust this folder?') };
      if (MODEL.test(ctx)) return { kind: 'model', hint: hintOf('Select model') };
      if (QUESTION.test(ctx)) return { kind: 'question', hint: hintOf('Claude has a question') };
      if (PERMISSION.test(ctx)) return { kind: 'permission', hint: hintOf('Claude needs permission') };
      // an unrecognised but real menu: the cursor, the numbering AND the TUI's own footer
      if (FOOTER.test(withBelow)) return { kind: 'select', hint: hintOf('Choose an option') };
    }
  }

  // 1b. a menu WITHOUT numbers. Claude Code 2.1 draws the folder-trust dialog as `❯ No, exit` over
  // `Yes, I trust this folder`, with no "1."/"2.". The structure that keeps this honest is the same
  // as above, minus the numbering: the selection cursor on a line near the end AND the TUI's own
  // footer (`Enter to confirm · Esc to cancel`) as the very last thing painted.
  if (FOOTER.test(lines.slice(-2).join('\n'))) {
    let cur = -1;
    for (let i = n - 2; i >= Math.max(0, n - 9); i--) if (CURSOR_LINE.test(lines[i])) { cur = i; break; }
    if (cur >= 0) {
      const ctx = lines.slice(Math.max(0, cur - 10)).join('\n');
      const pick = (re: RegExp, fallback: string): string => clip(lines.slice(Math.max(0, cur - 10), cur).find((l) => re.test(l)) ?? fallback);
      if (TRUST.test(ctx)) return { kind: 'trust', hint: pick(TRUST, 'Trust this folder?') };
      if (MODEL.test(ctx)) return { kind: 'model', hint: pick(MODEL, 'Select model') };
      if (QUESTION.test(ctx)) return { kind: 'question', hint: pick(QUESTION, 'Claude has a question') };
      if (PERMISSION.test(ctx)) return { kind: 'permission', hint: pick(PERMISSION, 'Claude needs permission') };
      return { kind: 'select', hint: clip(lines[cur - 1] ?? 'Choose an option') };
    }
  }

  // 2. not a menu, but still waiting on a keypress — only trusted on the very last lines
  const endText = lines.slice(-2).join('\n');
  const o = OTHER.exec(endText);
  if (o) return { kind: 'other', hint: clip(lines[n - 1]) };
  return null;
}

// ── a debounced watcher over the pty output ─────────────────────────────────

export interface PromptMonitor {
  /** Raw pty output, exactly as it arrives (ANSI included). */
  push(data: string): void;
  /**
   * What the terminal currently SHOWS (plain text, as the owner's emulator rendered it). The raw
   * stream cannot say this: Ink repaints a dialog differentially (moving the selection rewrites two
   * lines and not the footer), so the tail of the stream stops looking like a dialog while the
   * dialog is still open. A screen replaces the buffer instead of extending it.
   */
  screen(text: string): void;
  /** The transcript moved on (a tool finished, the operator typed): whatever was asked is answered. */
  clear(): void;
  /** Stop timers; nothing is emitted afterwards. */
  dispose(): void;
}

export interface PromptMonitorOptions {
  /** Called ONLY when the kind changes; `null` means the dialog is gone. */
  onChange(kind: TuiPromptKind | null, hint?: string): void;
  debounceMs?: number;
  /** Raw characters kept. ANSI-heavy redraws are ~3x their visible text, so this is a few KB of screen. */
  maxChars?: number;
  /** Injected so a test needs no real clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * Keeps a bounded tail of pty output and runs the detector on it AFTER output settles (a TUI repaints
 * a dialog in many small writes; judging each one would flicker). It reports transitions only: the
 * same kind twice is one event, and a dialog that goes away is `null`.
 *
 * Output alone cannot always say a dialog was dismissed (a repaint may leave its text in the tail),
 * so the owner also calls `clear()` when the transcript proves it was answered. `clear()` drops the
 * buffer too, otherwise the stale dialog text would be detected again on the very next repaint.
 */
export function createPromptMonitor(o: PromptMonitorOptions): PromptMonitor {
  const debounceMs = o.debounceMs ?? 120;
  const maxChars = o.maxChars ?? 16384;
  const setT = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let buf = '';
  let current: TuiPromptKind | null = null;
  let timer: unknown;
  let dead = false;

  const emit = (kind: TuiPromptKind | null, hint?: string): void => {
    if (dead || kind === current) return;
    current = kind;
    o.onChange(kind, hint);
  };

  function evaluate(): void {
    timer = undefined;
    if (dead) return;
    const r = detectTuiPrompt(buf);
    emit(r ? r.kind : null, r?.hint);
  }

  return {
    push(data: string): void {
      if (dead || !data) return;
      buf = (buf + data).slice(-maxChars);
      if (timer !== undefined) clearT(timer);
      timer = setT(evaluate, debounceMs);
    },
    screen(text: string): void {
      if (dead) return;
      buf = String(text ?? '').slice(-maxChars);
      if (timer !== undefined) clearT(timer);
      timer = setT(evaluate, debounceMs);
    },
    clear(): void {
      if (dead) return;
      buf = '';
      if (timer !== undefined) { clearT(timer); timer = undefined; }
      emit(null);
    },
    dispose(): void {
      dead = true;
      if (timer !== undefined) { clearT(timer); timer = undefined; }
      buf = '';
    },
  };
}

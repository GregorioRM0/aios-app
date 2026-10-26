# RFC: Chat view — a skin over the terminal session

- **Status:** Prototype, for discussion
- **Scope:** AIOS App (this repo). No framework change.
- **Code references:** `feat/chat-skin`, branched from 0.12.0 (it replaces the earlier `feat/chat-view` prototype)

## 1. Summary

The app's way to talk to Claude is a terminal, and that stays the right default (*Glass, not engine*:
the real `claude` CLI in a real pty, never reimplemented). But a terminal is a poor reading surface for
an operator who never opens an editor: no readable prose, no font choice, tool output that scrolls
away, no quiet "how much have I used".

This RFC describes a **chat view that is a visual layer over the same Claude Code session an existing
terminal pane already runs**. It is not a new pane, not a new session and not a second route to Claude.
Whatever starts a Claude pane today (Start / Launch, an agent, a ritual, `--resume`, a restored tab) keeps
doing exactly that; the pane just gains a switch, **Terminal ⇄ Chat**, that changes how the one session
is *looked at*. The pty and the `claude` process inside it remain the only source of truth. The chat reads
along (the session's transcript file, plus the tail of the pty output to notice dialogs) and writes back
through the same door the terminal uses. It never answers a dialog for the operator.

An earlier prototype (the `feat/chat-view` RFC this document replaces) built a separate "Chat" pane that
drove Claude through the Agent SDK. That pane was **removed** (§ 8). The pieces worth keeping — bubbles,
sanitised markdown, the font picker, the usage bar — were moved onto the skin.

It is a prototype: the loop is proved on a real session end to end by a gate in `npm run smoke` (§ 9), and
§ 10 lists what it does not do.

## 2. What it does for the operator

Every pane that runs Claude gets the switch; panes that run anything else (a shell, a viewer, a session
that has ended) do not.

- **Toggle, three doors.** A small icon on the pane's tab; *File → Switch Between Terminal and Chat*
  (`CmdOrCtrl+Shift+L`, acting on the focused or active pane); a row in the tab's context menu. Inside the
  chat view a `Terminal | Chat` switch in the header goes back. Flipping creates no pane and no pty.
- **Open in chat by default.** Settings → `chatViewDefault` (off unless the stored value is literally
  `true`). It is read fresh on each pane creation, so it covers new, restored and resumed sessions — all of
  them go through `createPane` with a `claude` command.
- **One reading column.** The conversation is a single centred column, at most ~748 px wide with 16 px
  gutters, so a wide dock reads like a page and a narrow one simply fills. The log itself spans the pane (its
  scrollbar stays at the pane's edge); the column is made with side padding, which resolves against the pane.
  The look is inspired by the layout of chat apps in general (a column, boxes, compact tool rows, a floating
  composer); it uses the app's own tokens, Inter or the system font, and none of anyone's marks.
- **Boxes.** The operator's message is a soft rounded box on the right (plain text, line breaks kept). Claude's
  reply has **no bubble**: it is text across the whole column, markdown rendered once the message is complete,
  with a reading hierarchy (1.7 line height, headings, lists, quotes, links, rules), inline code on a soft
  fill, a **header on every code block** (language on the left, a **copy** button on the right: clipboard
  through the shell, "Copied" feedback) and **framed tables** (tinted header, faint zebra, their own horizontal
  scroll). The "You" / "Claude" labels are gone from the screen and remain, hidden, for screen readers. The
  code header, the copy button and the table wrapper are built as DOM *after* the sanitiser (§ 8), so the
  allowlist did not change and no `<button>` can come from the model. Notes for system events (an
  interruption, an API error, the output of a local command) are small centred pills.
- **Tools as rows, with their output.** Each tool call is one compact row: a glyph by kind (read, edit, bash,
  search, web, agent; a wrench for the rest, MCP tools included), the name, its main argument truncated with an
  ellipsis, and a state mark: a quiet spinner in `--st-busy`, a check in `--st-ok`, a cross in `--st-error`
  (never coral). Consecutive rows join into one card. A row is a button (`aria-expanded`): opened, it shows
  what the tool returned (`ChatItem.tool.output`, § 3.2) in monospace, height-capped with its own scroll, with
  a notice when only the start was kept, or a neutral line when there is nothing (or the tool still runs). The
  status moves **in place** on the same node, so a row the operator opened stays open. The output is
  untrusted text and only ever goes in through `textContent`.
- **Activity indicator.** Three dots in `--st-busy` and "Claude is working…" **inside the column, under the
  last message**, while a turn is open and the pty has produced output recently, or a message was just sent.
- **The composer.** One large rounded card floating over the end of the conversation (a soft shadow, the
  text fading out under it): a textarea that grows to a ceiling and then scrolls, a bottom row with a **model
  chip** and an **effort chip** (read from the same usage data, § 6) and a **round send button** that
  becomes a round **stop button** while Claude works (`chatSkinControls` is unchanged: stop when working,
  send disabled without text). Enter sends; Shift+Enter inserts a newline; IME composition never sends. Esc
  cuts the running turn (only while something is running — see § 3). Slash commands are sent like any other
  message, with no filter and no special path. The box is neutral: its border does not change colour on
  focus (a slightly stronger neutral edge and a faint halo), keyboard focus on the small controls is a neutral
  outline, and **the accent colour is used for the send button and nothing else** in the chat — markdown
  links take a cool `--chat-link` token (the house has no link token, and the markdown viewer's coral links
  are spoken for here). The chips stay **inside the card** and the meters go **under it**: model and effort
  say what will answer *this message* (they are part of the act of writing it), whereas the meters are the
  ambient cost of the session, read at a glance and never while typing. Putting all five in one row made the
  row a toolbar; split, the card stays a calm box and the row below stays quiet.
- **The usage row under the card.** The 5-hour, weekly and context meters are not in the header any more
  (the header carries the `Terminal | Chat` switch and the Aa button). They are a thin row under the card:
  each meter is a small ring (the glance), the label and the value (the fact), neutral up to 70, `--st-warn`
  from 70 and `--st-error` from 90 (thresholds on the percentage, whatever number is on show). A reading we
  do not have is `—` with an empty ring, never `0`. Every meter is focusable (`role="img"`, an
  `aria-label` with the value and the detail) and answers hover **and** keyboard focus with a tooltip of its
  own (not a `title`): the window's usage, **when it resets** (clock time today, weekday and time
  otherwise, plus the two largest units left) and, for context, **tokens used over the window**. The reset
  lines appear only when the statusline payload carried `rate_limits.*.resets_at` (read by
  `parseStatuslinePayload`, § 6); a reset already behind us says the reading is from the previous window and
  dims it. The grey "Enter sends · Shift+Enter…" line became a short hint at the right end of the same row
  that shows **only while the caret is in the box**; the full sentence is the textarea's tooltip and its
  accessible description. While a dialog docks the live terminal strip (`.pane.cs-strip`), the whole compose
  block (card, row and hint) is hidden, since nothing can be typed.
- **Slash commands.** Typing `/` at the very start of the box opens a popup above the card listing what the
  operator can run: Claude Code's built-in commands, the AIOS plugin's `/aios:*`, the operator's own
  (`<config dir>/commands`), the project's (`.claude/commands` of the pane's folder) and the installed
  plugins'. Each row shows the name, its usage hint (`argument-hint`) and what it does (`description`), plus a
  small tag when it is the operator's or the project's own. It filters as they type (name, then alias, then
  the part after a `plugin:` prefix, then any word). ↑/↓ move (and wrap), **Enter or Tab complete** the
  highlighted command into the box as `/name ` and **never send** — the operator still reads the line and sends
  it with a second Enter; a click completes too; **Esc closes the popup and does not cut the turn** (its
  listener runs before the interrupt one, as the Aa popover's does). It closes on blur, on sending, when the
  text stops being a lone slash word and when the command is already complete. Accessibility: the textarea is
  a `combobox` over a `listbox` of `option`s with `aria-activedescendant`. It only ever completes text; it
  writes nothing to the pty.
- **Files in the box.** Dropping files (from Finder or from the explorer) or an image on the card, or pasting
  an image, inserts its **absolute path in double quotes** at the caret, as Claude Code's own terminal does;
  it never sends. The drop stops at the card (the pane under it has its own drop zone that would write the
  path to the pty a second time). A picture with no file behind it goes through main, which saves it under
  the system temp folder (`aios-chat-paste/`, a name main chooses, png/jpeg/gif/webp, ≤ 25 MB, own files older
  than a day swept) and returns the path.
- **Reading settings.** Font and size no longer take header space: an **Aa** button opens a small popover
  (each font drawn in itself, the size as a row of numbers, a live sample), persisted through the same
  `chatFontFamily` / `chatFontSize` settings and shared by every chat view; a stack or size saved by hand
  stays selectable. It closes with Esc or a press outside, and **that Esc must not cut the turn**: its
  listener runs before the interrupt one and stops the event (§ 9: a test pins the order).
- **Cards for the states.** *Connecting*, *waiting*, *empty* and *error* are one centred card (icon, a short
  title, a sentence; the error one adds a button back to the terminal). *The terminal needs you* (a dialog) and
  *quiet for a while* (a stalled turn) are a status card in the column — `--st-input` and `--st-warn` — with
  the same button for the stalled case; under a dialog it docks onto the live terminal strip (§ 5).
- **Motion, only as an answer to events.** A row that arrives rises a few px while it fades in (not for history
  loaded within 1.5 s of a reset); the log glides to the tail while the view is following it (`cs.stick`; a
  wheel-up takes the control back at once) and a round *latest* button appears when the operator has scrolled
  away. Every animation has a `prefers-reduced-motion` fallback.
- **Always a way out.** The header switch, the tab icon and the notice button all return to the terminal.

## 3. Architecture

```
                    ┌────────────────────────── main ───────────────────────────┐
 claude (real TUI)  │                                                            │
   ▲   │            │  pty:data ─┬─► renderer (xterm, hidden but alive)          │
   │   │ writes     │            └─► PromptMonitor ── 'prompt' ──┐               │
   │   ▼            │                 (core/tuiPrompt.ts, pure)   │               │
  pty ◄── pty:write ┤                                             ▼               │
   │                │  <slug>/<sessionId>.jsonl                chatSkin:event ────┼─► renderer
   └─ appends ───►  │     │  fs.watch + poll                    (paneId + …)       │    (chat overlay)
   (transcript)     │     ▼                                         ▲              │
                    │  transcriptTail.ts ─► tracker (pure) ─────────┘              │
                    │  offset, split lines,   core/transcriptChat.ts               │
                    │  late file, id change                                        │
                    └────────────────────────────────────────────────────────────┘

 renderer ─ submitToPty(id, text) ─► pty:write (text, then CR as a second write) ─► claude
 renderer ─ chatSkin:screen (what xterm shows, snapshots) ─► PromptMonitor
```

**Two inputs, one output, one way back.**

- *Transcript tail* (`src/main/transcriptTail.ts`, no electron import). Given a `paneId` and a
  `sessionId`, it locates `~/.claude/projects/<any project folder>/<sessionId>.jsonl` (the cwd slug is
  not known to the caller, since a session may have been resumed from elsewhere, so every subdirectory is
  tried), reads it in 1 MiB async chunks and feeds each complete line to the tracker. It must survive
  what real transcripts do:
  - *the file does not exist yet* (a new session writes its first line seconds after launch): it emits
    `missing` once and keeps searching, at a slower pace after about 30 polls;
  - *a line written in two halves*: the unfinished tail is held until its newline; a multi-byte character
    split across reads is decoded whole (`StringDecoder`);
  - *large files*: backfill is chunked and async, never blocking main;
  - *truncation or replacement* (different inode, or size below the offset): `reset`, then re-read from
    the top;
  - *`fs.watch` is unreliable* (coalesced events, missed after a replace, `EMFILE`): a 1 s poll runs
    alongside and is the guarantee; the watcher only makes it quicker;
  - *the sessionId changes* (`/clear`, a resume that forks): the renderer unwatches and re-watches; one
    watch per pane, a new one replaces the old.
- *Tracker* (`src/core/transcriptChat.ts`, pure). Turns lines into `ChatItem`s and tracks the turn state
  and the context size. It never throws on a corrupt line.
- *Dialog detector* (`src/core/tuiPrompt.ts`, pure). Reads the pty's output and, once the renderer sends
  them, snapshots of what its terminal shows. Only to notice that the TUI is waiting on a dialog (§ 5).
- *Writing back*: **only** `submitToPty(id, text)`, the chokepoint that writes the text and then the CR
  as two separate writes. Claude Code turns on bracketed paste, so a single `text + CR` write arrives as
  one paste, inside which the CR is a literal newline: the message lands in the box and never sends.
  `npm run check:tokens` fails when a renderer line matches the one-chunk pattern (`ptyWrite(… + '\r')`).
  The only other thing the skin ever writes is a lone ESC (`\x1b`) to cut a running turn, and only while
  something is running, because an idle Esc is not harmless in Claude Code (a second one opens the
  rewind menu).

**`paneId` is the pty id.** `pty:spawn` returns `nextId++` and stores it in `ptys`; the renderer keys its
`panes` Map and `ptyWrite` by it; the skin map in main uses the same number. There is no translation
layer to drift.

**Lifetime of a watch.** Created by `chatSkin:watch`, which may be called **without a session id** (`null`:
"dialogs only", no transcript yet — § 5); a later `chatSkin:watch` with the real id replaces the transcript
and keeps the same dialog monitor, so a dialog still open is neither forgotten nor announced twice. Ended by `chatSkin:unwatch`, the pty's exit (after
one last read pass, `finish`, because a session's closing lines land just before it exits), `pty:kill`,
destruction of the sender, or closing the window / quitting. A `watch` for a pane whose pty has already
exited is accepted (it shows the history) and lasts until `unwatch` or the window goes.

### 3.1 Hiding the terminal without breaking it (fit / resize)

The xterm is **hidden, never detached and never `display:none`'d**. An absolute overlay covers the pane
and `.twrap` becomes `visibility:hidden`, which keeps its box. The reason is the fit addon: it measures
the container, and a zero-size container yields 0 columns; the resulting `pty:resize` would reflow and
tear the TUI, a failure that shows only when the operator comes back to the terminal. Consequences the
code and its tests hold to:

- the skin never calls `fit()` while it is up; the **only** `fit()` in the block is the one in
  `chatSkinHandBack`, run once when the terminal is handed back (followed by the usual geometry push);
- no skin CSS rule uses `visibility:visible`, which would punch through `.panehidden` by inheritance; the
  dialog strip uses `inherit`.

### 3.2 Event contract (`chatSkin:event`)

Every event carries `paneId` plus exactly one of:

| Event | Meaning |
|---|---|
| `{type:'reset'}` | Empty the view. Sent before a backfill and whenever the file is replaced or changes. |
| `{type:'items', items}` | **Upsert by `uuid`**, in order. The same `uuid` may arrive again with new content. |
| `{type:'turn', open}` | A turn started or ended. |
| `{type:'usage', contextTokens?, model?}` | This session's own numbers. Not sent when neither is known. |
| `{type:'prompt', kind\|null, hint?}` | The TUI is (or stopped) waiting on a dialog (§ 5). |
| `{type:'missing'}` | The transcript file does not exist yet. Not an error; main keeps looking. |
| `{type:'error', code}` | The read failed (`read-failed`). |

`ChatItem = {uuid, role: 'user'|'assistant'|'tool'|'system', text?, tool?: {id, name, summary, status: 'running'|'ok'|'error', output?, outputTruncated?}, ts?}`.
`tool.output` is a bounded preview of the tool's result (ANSI and control characters removed, at most 4,000
characters and 60 lines, cut at the head; `outputTruncated: true` when it was cut) that exists only once the
result has arrived. It is **untrusted data**: the renderer shows it through `textContent` only. It is not
redacted, because it goes to this app's own window and nowhere else (`core/transcriptChat.ts` says why).
Details the renderer relies on:

- During a backfill only `items` are streamed; `turn` and `usage` are announced **once** when it ends,
  so a long history does not flicker the indicator.
- A tool item uses the `tool_use` id as its `uuid`; when the result arrives the same `uuid` comes again
  with `ok` or `error`. A tool still running when the transcript records an interruption is marked `error`.
- `prompt` is sent only when the kind *changes*; `null` means the dialog is gone.
- Absent numbers stay absent, never `0`.

IPC surface: `chatSkin:watch(paneId, sessionId | null) → {ok:true, file} | {ok:false, error:'not-found'|'bad-id'}`
(`not-found` does not stop the search; with `null` the answer is `{ok:true, file:''}` and only the dialog
monitor starts), `chatSkin:unwatch(paneId)`, `chatSkin:screen(paneId, text)` (one-way: the terminal's
screen snapshots, accepted only from the sender that owns the watch), the `chatSkin:event` stream, and
`chat:status` for the usage bar. The `sessionId` becomes part of a path, so anything not shaped like an id
(`/^[A-Za-z0-9-]{8,}$/`) is refused before it is joined. The renderer treats `not-found` as "waiting", not
as an error: a new session has no transcript file until its first message.

## 4. The transcript format, as verified

Verified by reading real transcripts under `~/.claude/projects` read-only (nothing copied; no content
appears here or in any fixture). The format is Claude Code's own and **not a documented contract** (§ 10).

- One JSON object per line. Lines that carry the conversation lead with `parentUuid`; bookkeeping lines
  lead with `"type"`: `last-prompt`, `custom-title`, `ai-title`, `agent-name`, `mode`, `permission-mode`,
  `bridge-session`, `queue-operation`, `file-history-snapshot`, `api-request*` and similar. The tracker
  checks the leading `"type"` with a regex and **skips those without parsing them**, which matters
  because some (request blobs) are enormous. `attachment` lines do *not* lead with `type`; they are
  parsed and then ignored by the type switch.
- **Used:** `user`, `assistant`, `system`. **Ignored:** everything else.
- **`assistant` is split by block.** One line per content block (`thinking`, `text`, `tool_use`), all of a
  message sharing `message.id` and the same `message.stop_reason`. So `stop_reason: "end_turn"` on a
  `thinking` line says nothing about whether the text has been written. The turn is closed only by a
  `text` block with `end_turn`, or by `system` / `turn_duration`, or `system` / `stop_hook_summary`.
  `thinking` blocks are not shown. Any other assistant activity marks a turn open.
- **Usage** comes from `message.usage` of the latest real assistant message: context tokens =
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, reported only when the input
  side is really present; the model from `message.model`.
- **Synthetic messages:** model `<synthetic>` (stop reason `stop_sequence`, API-error text). Shown as a
  `system` note; the turn ends.
- **`user`:** `message.content` is a string (what the operator typed, or an injected prompt) or a list of
  blocks. Blocks are `tool_result {tool_use_id, content, is_error?}` or `text` (a typed prompt with
  attachments, or the interruption marker `[Request interrupted by user…]`). A result flips the matching
  tool item and marks the turn open.
- **What is dropped as "not typed by the operator":** `isMeta` lines (skill bodies, auto-continuations,
  caveats), `isSidechain` lines (a subagent's chatter), and the wrappers `<system-reminder>`,
  `<local-command-caveat>`, `<task-notification>`, `<command-message>`, shell-capture tags. A slash command
  is stored with `<command-name>` / `<command-args>` and is shown as the `/name args` the operator typed;
  `<local-command-stdout>` / `-stderr` becomes a `system` note.
- **`system` subtypes** seen: `turn_duration`, `stop_hook_summary`, `api_error`, `local_command`,
  `informational`, `away_summary`, `compact_boundary`, `bridge_status`. Only the first two are used.

*Not verified in this pass:* every subtype above on a single recent file (the sample I re-read showed
`turn_duration`, `informational`, `away_summary`, `bridge_status`); behaviour across Claude Code versions.

## 5. Dialogs the chat does not represent

The transcript learns about a tool *after* the operator allows it. While the TUI sits on "Do you want to
proceed?", the transcript shows a `tool_use` with no result and says nothing else; the question exists only
on the screen. The same goes for the folder-trust prompt, `/model`'s picker, an `AskUserQuestion`, and any
numbered menu. The chat cannot draw them and **does not try to answer them**.

**Detection** (`detectTuiPrompt`, pure; `createPromptMonitor` wraps it). It is judged 120 ms after its input
settles, because a TUI repaints a dialog in many small writes, and it works from **what the terminal shows,
not from the byte stream** (`39d60fd`):

- Ink repaints a dialog differentially (moving the selection rewrites two lines, not the footer), so the tail
  of the raw stream stops looking like a dialog while the dialog is still open. The renderer's xterm is the
  only thing that knows the screen *now*. While a pane is in chat view, after xterm has parsed each chunk
  (the callback of `term.write`, `chatSkinScreenSoon`), the renderer sends at most one snapshot per 150 ms
  window: the last 60 rows of xterm's buffer as plain text (`chatSkinScreenText`) over `chatSkin:screen`.
  Main keeps the last 8 KiB, and the monitor's `screen()` **replaces** its buffer instead of extending it.
- Until the first snapshot of a pane arrives, the monitor is fed the raw pty output (`push`, bounded tail of
  16 KiB). Once one has arrived (`screenFed`), the raw stream is no longer fed: mixing the two would let a
  repaint talk the monitor out of a dialog that is still open.
- A dialog that was already on screen needs no new bytes to be seen. Main keeps a per-pty tail of the last
  16 KiB of output from the moment the pty spawns (`ptyTails`) and pushes it into a monitor when one is
  created; and `chatSkinSync` asks for a snapshot as soon as a watch starts.

A verdict needs *structure*, not wording, because ordinary answers are full of numbered lists and sentences
like "Do you want to proceed?":

1. a numbered option list (consecutive, at least two) with the TUI's selection cursor `❯`, whose last option
   is within five non-empty lines of the end of a 40-line tail (a dialog is the last thing painted);
   *or an unnumbered menu* (`ec1c440`): a `❯ label` cursor line between the second-to-last and the
   ninth-to-last non-empty line **and** the TUI's own footer (`Enter to confirm`, `Esc to cancel`, …) in the
   last two. Same structure, minus the numbers;
2. a recogniser around it that only the TUI prints — trust, model picker, question chips / "Type something",
   permission wording — or, for an unrecognised but real menu, the TUI's own footer (`Enter to select`,
   `Esc to cancel`);
3. kinds: `permission · trust · select · question · model · other`; `other` is deliberately narrow (a
   keypress prompt such as `(y/n)` on the very last lines). The `hint` is the question line, trimmed.

**The folder-trust dialog, as Claude Code 2.1 really draws it** (`ec1c440`). The detector was first written
against numbered menus. The real dialog is `Accessing workspace:` and the folder, then `Quick safety check:
Is this a project you created or one you trust?`, `Security guide`, and two **unnumbered** rows, `❯ No, exit`
over `Yes, I trust this folder`, with `Enter to confirm · Esc to cancel` as the last line. Two things made
it invisible: the TUI places words with an absolute column (`ESC[<n>G`), and dropping that sequence glued
them (`Quicksafetycheck`) so no wording could match; and the missing numbers failed the menu rule. Now
`stripAnsi` turns the absolute-column sequence into a space, and the unnumbered menu above is accepted. The
trust recogniser matches `Quick safety check`, `trust this folder` / `trust the files in this folder`,
`Do you trust the files` and `Yes, I trust`; the `hint` is the first context line that matches, normally
the `Quick safety check` line. The numbered variant is still recognised. `src/test/chatSkin.test.ts`
holds the real sequences (a raw stream with the column sequences, a repaint that moves the cursor, a screen)
with controls: stripping the column sequences instead of spacing them yields no verdict, and a raw stream
followed by the repaint reads as "gone" while the screen still shows the dialog.

**What the operator sees.** A non-null `prompt` puts `cs-strip` on the pane: the overlay shrinks to the
upper part and the **real xterm** is un-hidden in the lower strip (so the TUI's bottom rows, where the
dialog is drawn, are visible) and takes the focus. A notice (`role="alert"`) says what is being asked. The
box is disabled for the duration. If the pane is not in front or the window is hidden, the tab is marked
and a toast says which session needs the operator. When the dialog goes (`kind: null`) the strip closes and
the caret returns to the box.

**When the dialog is considered answered.** The screen moving past it (a snapshot that no longer shows one;
before the first snapshot, the pty output), or *proof from the transcript*:
a finished tool result or a new operator message (main calls `monitor.clear()`). A fresh assistant text does
**not** clear it, on purpose: model text can appear while a dialog is still open.

**Safety net — "never blocked without the operator seeing it".** Detection is a heuristic, so there is a
second line of defence that does not depend on recognising anything: an *open turn* with a *live pty* and a
transcript silent for more than 20 s raises a notice with a **Show terminal** button. In that state the
renderer also re-asks the process tree for the live sessionId (at most three times per watch), since a
silent transcript can mean the session was replaced under the same pty.

**Honest limits.**

- The wording is the CLI's and changes between versions; recognition is English-only. Strings were checked
  against the shipped CLI at the time of writing.
- A dialog taller than the retained window loses its question line (the kind then falls back to `select`).
- A false positive sends the operator to the terminal for nothing; a false negative leaves the session
  looking idle until the 20 s net fires. The design leans to the first.
- **A dialog with nothing to anchor on is not recognised.** The first-run offer to make auto mode the
  default has no footer and is not a kind the detector knows; the smoke gate (§ 9) answers it itself. The
  same goes for any new first-run nag a CLI version adds.

**Before the session has an id** (`39d60fd`). A new session in a folder Claude Code has not seen blocks on
the folder-trust dialog *before* it registers a session id. The chat view used to start watching only once
it had one, so the overlay hid the only thing the session was waiting on. Now `chatSkinSync` watches as soon
as the pane is in chat view and its pty is alive: with no id the watch is `''` in the renderer and `null`
on the wire, main starts only the dialog monitor, and the view reads "connecting". The strip and the notice
work exactly as for any dialog. When the id is adopted the watch is replaced by one that also follows the
transcript, keeping the monitor.

## 6. The usage bar: what is the pane's and what is the account's

`~/.claude/statusline-payload.json` is the last payload written by **any** Claude Code session on the
machine. It is global, not per tab. Therefore:

- **5-hour and weekly percentages are the account's** numbers (the most recent session's reading of them),
  which is what they are in Claude Code too; they do not belong to this pane. Effort is also read from the
  payload and is likewise not guaranteed to be this pane's.
- **Context and model of the pane come from this session's own transcript** (the `usage` event) whenever
  it has them: the context shows as tokens (for example `84k`), the model overrides the payload's. The
  payload only fills what the transcript cannot say, field by field.
- **Resets and the context window.** The payload also carries `rate_limits.five_hour.resets_at` and
  `rate_limits.seven_day.resets_at` (Unix seconds) and `context_window.context_window_size`.
  `parseStatuslinePayload` returns them as `fiveHourResetsAt`, `sevenDayResetsAt` and `contextWindow` only
  when they are usable numbers (a reset written in milliseconds is scaled; anything else is dropped);
  `mergeStatus` carries them with the same field-by-field rule. Nothing is inferred: with no reset in the
  payload the tooltip simply has no reset line. The context meter's percentage is this pane's own tokens over
  the window size **only when they agree** (tokens above the window mean the payload describes another
  session's model), and the tooltip then reads `used / total`.
- An absent field is shown as `—`, never `0%`: a bar that shows `0%` for a missing number is a fabricated
  reading. `chat:status` returns the merge of nothing with the parsed payload (`parseStatuslinePayload`,
  `mergeStatus`) and is refreshed about every 20 s while a chat view is up.
- Open item: the exported type still carries the label `source: 'sdk' | 'file' | 'mixed'` from the SDK era;
  only `file` is produced now.

## 7. Invariants that hold because the pane is the same

The skin adds fields (`p.view`, `p.chatSkin`, `p.viewBtn`, …) and DOM nodes inside `p.el`, and nothing
else. So everything that finds or controls a pane keeps working untouched:

| Invariant | Why it holds |
|---|---|
| **name, `byName`, ambiguity** | The skin never assigns `name`, `confirmedName` or `cmd`, never calls `renamePane`, `panes.set/delete`. |
| **resume** | A resumed session is a normal `createPane` with `claude --resume`; the skin attaches by `sessionId` like any pane. |
| **bus `send` / `kill`** | They address the pane and its pty; `send` goes through the same `submitToPty` the box uses. |
| **`runInPrimary`, rituals** | They write into the primary pane's pty; the skin is just another way to look at it. |
| **closing the tab** | `closePane` tears the watch down before the pane and its id go away. |
| **restore** | Restored panes come through `createPane`; `chatViewDefault` applies to them. |
| **no second session** | Toggling spawns no pty (`createPane`, `ptySpawn`, `new Terminal` are absent from the toggle path). |

The one deliberate exception is stated and bounded: the skin may **correct** `p.sessionId` (a `/clear` or
a forking resume replaces the session under the same pty), by asking the process tree (`session:under`),
the same authority the other adoption sites use. There is exactly one `sessionId` assignment in the skin.

How the tests cover it: `src/test/chatSkin.test.ts` reads the source and checks each of the above, and each
check is paired with a **negative control** — the same check run on a deliberately broken copy must fail
(for example: a toggle that calls `createPane`; a box that writes `text + '\r'` itself; a hidden host given
`display:none`; a dialog notice without `role="alert"`). A check that cannot fail would report confidence
about something it never examined.

## 8. Decision: the Agent SDK "Chat" pane was removed

The previous prototype added a pane kind, **Chat**, that ran Claude through the Agent SDK
(`chatSession.ts`, `@anthropic-ai/claude-agent-sdk`). This branch **removes** it, with the dependency and
its `asarUnpack` entry. Reasons:

1. **Two paths to Claude with different semantics.** In the SDK pane, permissions were decided by a
   `canUseTool` callback the app implemented; in a terminal they are decided by the TUI against the
   operator's settings. The same operator could get different behaviour in two tabs of the same app, and
   the app owned one of the two permission engines — exactly the thing it should not own.
2. **A session foreign to everything the app knows about sessions.** An SDK chat was not reachable by
   `byName`, the command bus (`send` / `kill`), rituals, `runInPrimary`, or `--resume`: none of those can
   address a session that is not a pty pane. Each missing integration would have had to be rebuilt for a
   second kind of session, or left as a permanent hole.
3. **Duplicating the engine.** *Glass, not engine*: the real `claude` in a real pty is the product. An SDK
   session re-drives the same engine from inside the app (queueing input, interrupts, approvals), which is
   the reimplementation the principle rules out.
4. **Weight of the dependency.** A 0.x package tied to a native binary, one optional package per platform,
   a lockfile diff of roughly 1.3k lines (removed again here), an unpacked-from-asar binary whose packaged
   behaviour was never verified.
5. **Maintenance surface.** A second event model, a second set of IPC channels and a pane kind to keep in
   step with every change to panes.

**What was reused** (it lives in `renderer/app.js` between `CHAT SKIN` and `END CHAT SKIN`; the look of all of it was redesigned afterwards, § 2): the bubbles;
the sanitised markdown (a private `marked` instance that escapes raw HTML, then an allowlist pass over an
inert `<template>`, two independent guards because model output can quote a web page or an email and this
renderer holds the whole `glassShell` bridge) and the highlighting; the font and size picker with its
settings; the usage bar; and from `core/chatEvents.ts` the pure helpers `parseStatuslinePayload`,
`mergeStatus` and `summarizeTool`. The SDK-specific event types and the permission cards are gone.

What is given up: the SDK's structured streaming (partial deltas) and approval cards. The skin shows
complete messages from the transcript and sends permission decisions to the terminal. That is the price of
there being one session.

## 9. How it is tested

- **Unit tests with neutral, hand-written fixtures, each with a negative control.**
  `src/test/transcriptChat.test.ts` (the rules in § 4: split assistant, tool upsert, filtered wrappers,
  interrupts, synthetic errors, usage), `src/test/tuiPrompt.test.ts` (each dialog kind; a normal markdown
  answer and a lone numbered line trigger nothing; a dialog that scrolled away is gone; the monitor
  reports transitions only), `src/test/transcriptTail.test.ts` (runs the tail for real against a temp
  folder: late file, line in two halves, a multi-byte character split across reads, truncation, id change,
  `unwatch` leaves no watcher, ids that are not id-shaped never touch the filesystem).
  `src/test/chatSkin.test.ts` holds the wiring invariants of § 7. Fixtures are written by hand; no real
  transcript is copied into the repo. The controls are real: breaking the UTF-8 decoder on purpose made the
  multi-byte test fail.
- **Guards that read the code and run it.** `src/test/chatSkin.test.ts` also pins, each with a negative
  control (the check is run against a deliberately broken copy and must fail): coral only in the send button
  (every stylesheet rule that reaches for `--accent` inside the chat is listed and only the send button
  passes); the meters are no longer in the header; the popup's Esc listener is registered before the
  interrupt one and stops the event (the two listeners are replayed in registration order with a fake event);
  Enter with the popup open completes and is consumed, so it cannot send; the drop inserts the double-quoted
  path and stops the event before its early return. The usage row, the popup and the drop/paste code are
  **run for real** from the real source against a stand-in DOM (dash and empty ring for a missing reading,
  70/90 colours, resets present or absent, a stale reset, a stale popup answer ignored, caret and spacing of
  an inserted path). `src/test/slashCommands.test.ts` covers the pure module (merge precedence, ranking,
  what the box is asking for) and `src/test/usageReader.test.ts` covers the statusline parser, the new reset
  and window-size fields included (absent, unusable and millisecond values).
- **Shots.** `npm run chat:shot` (hidden window) renders hand-written cases in dark and light and in narrow
  and wide panes: the usage row at rest, each tooltip forced open by the fixture, high and empty readings,
  dense tool rows, the slash popup (all sources, filtered, narrow, and through the real IPC) and the drop
  veil and inserted paths.
- **End-to-end gate in the smoke run** (`chatViewSmoke` in `src/main/main.ts`, `97cf42d`). The last step of
  `npm run smoke` (`electron . --smoke`), run in the hidden window the smoke already uses (`show: !SMOKE`),
  after the fast gates and outside their 25 s ceiling, because it waits on a model and has deadlines of its
  own. It is skipped when an earlier gate failed, so a broken build does not also spend a model call. A smoke
  run uses a private, throwaway userData folder, so it neither reads nor writes the operator's local storage
  while their app is open. It never opens a window on the operator's screen: it is run only through
  `npm run smoke`, not with `npm start`, `--eval` or `--shot`.
  - *Switches.* `AIOS_SMOKE_CHAT` unset: it runs when a usable `claude` is found (on the `PATH` and signed
    in) and is `SKIPPED` otherwise (a laptop without it, CI). `AIOS_SMOKE_CHAT=1`: a gate that cannot run
    is a **failure**, because "did not run" must never read as "passed". `AIOS_SMOKE_CHAT=0`: skipped on
    purpose. `AIOS_SMOKE_CHAT_DEBUG` prints periodic progress lines (rows, state, pty age, the last screen
    rows) while it waits for the answer.
  - *What it proves.* It drives the whole path through the same functions the operator's hands drive:
    1. `createPane`, the launch path every session uses, in a fresh temporary folder (`aios-smoke-chat-*`)
       with `claude --model haiku`, its own name, `--strict-mcp-config` and a `--settings` blob that turns
       hooks off, remote control off and the status line into a no-op, and with the environment inherited
       from a launching Claude session dropped (`env -u`), so a throwaway session reaches nothing of the
       operator's world;
    2. the tab's Terminal/Chat toggle pressed **at once**, while the session is still blocked on the
       folder-trust dialog and has no id, which is exactly when the chat view must not hide the terminal;
    3. the wait (up to 75 s) for the pane to adopt its session id and for the chat view to follow it. It
       records whether the detector reported `trust`, and answers the dialogs itself by reading the screen
       and moving the cursor: "Yes, I trust" for the trust dialog and "No" for the auto-mode offer. No
       session id in time is a failure that says whether the detector ever reported the trust dialog;
    4. a message typed into the chat composer and sent with Enter (`submitToPty`), asking for exactly a
       random word (`PONG-` plus eight hex digits);
    5. an operator bubble **and** an assistant bubble carrying that word, painted from the transcript
       (up to 90 s). A dialog that interrupts the turn is a failure.
  - *How it cleans up.* On success and on failure it closes the pane, checks that the `claude` process
    tree is gone (killing by pid and reporting a problem if not), that the pty and the transcript watcher
    are unregistered and that the session left the registry, and removes the temporary folder and the
    transcript folder Claude Code made for that cwd, after checking the name and the location and that it
    is not a symlink. Any leftover turns an `ok` into a failure.
  - *Exit code.* Only a `FAILED` verdict (or an earlier gate failing) exits non-zero; `SKIPPED` does not.
  - `src/test/chatSkin.test.ts` pins the shape of the gate (hidden window, skip and strict modes, cleanup in
    `finally`, deletion only of what it can name) with negative controls.
- **Gates for a change like this:** `npm test`, `npm run smoke`, `npm run check:tokens` (no colour
  outside `theme.css`; every pty submit goes through `submitToPty`), `npm run check:whatsnew`.
- **What source-reading tests cannot see:** that the bubbles actually paint and that the detector sees a
  real dialog. The smoke step above now covers both against a real session. What it does not look at is
  the geometry of the strip (that the real xterm is un-hidden in the lower part and takes the focus); that
  is what the screenshot harness below shows.
- **Looks are verified by looking: `npm run chat:shot`** (`2d30d9b`). A CSS rule can pass every source test and
  still draw an unreadable column, so the visual design is checked on pictures. The harness boots the real
  renderer in a window that **is never shown** (`show:false`, a lock that cancels `show()`, `focus()` and
  `restore()`, and a `show` handler that hides it again; the unit suite pins it with negative controls),
  with a private `userData` under the temp folder, at device scale factor 2, and writes one PNG per *shot* of a
  hand-written fixture (`src/test/fixtures/chat-shot.json`, neutral: an invented sync client, no real
  transcript). `npm run chat:shot -- --out <dir> [--fixture <file>]`.
  - A shot is `{name, theme: dark|light, events, composer, terminal, js, size, layout, clip: window|pane,
    working}`. `events` names streams of the same events `chatSkinHandleEvent` receives (reset, items, turn,
    usage, prompt, missing, error, plus `status` for the usage meters); `js` runs in the renderer with
    `{cs, root, $, $$, sleep}`, which is how a shot opens a tool row or the settings popover.
  - The fixture covers what the design must hold: operator boxes, an answer with headings, lists, inline code,
    a TypeScript and a bash block, a table, a quote and a link; a read, then a run of three tool calls in three
    states (done, failed, running) with one opened to show its output; the composer with text and the stop
    button; usage meters (and a high-usage variant that turns them gold and red); the settings popover open; the
    attention card over a live dialog; the empty state; a narrow window; the stock workbench layout; all of them
    in dark and light where it matters.
  - How it is used: after every visual change, look at **every** PNG (dark and light) before calling it done —
    spacing, hierarchy, contrast in the light theme, truncation, shadows. It does not replace the gates; it is
    the one place a redesign is actually seen. It never answers a dialog and never writes to a pty.

## 10. What it does not do yet, and risks

**Not done**

- **Partial streaming.** Messages appear when complete, as the transcript records them.
- **Tool output beyond the preview.** Rows show the bounded preview (§ 2, § 3.2); the full result stays in the
  transcript and the terminal. A very long output, or a diff rendered as a diff, is not drawn.
- **Thinking and subagent activity** are not shown (subagent lines are dropped on purpose).
- **Answering dialogs** from the chat; they are only pointed at (§ 5).
- **`@` mentions** in the box (files and images arrive as quoted paths, § 2, not as attachment chips).
- **A permission-mode picker.** The chat follows what the session already runs under.
- **Accessibility pass** beyond the log region, the alert notice and `aria-pressed` on the switch.
- **Cloud mode.** The tail reads a local file; moving sessions behind a host is the cloud-mode RFC's
  concern, and the tail's injected projects folder and callback are the seam.

**Risks**

- **The transcript format is Claude Code's, not a contract.** Field names, the split-by-block shape, the
  end-of-turn markers and the wrapper tags can change between versions. The tracker is defensive (unknown
  lines are ignored, nothing throws), which means a change degrades silently into a thinner chat, not a
  crash. There is no version check.
- **The TUI heuristic is fragile across versions** (wording, layout, glyphs). The 20 s stalled-turn notice
  is the guarantee, not the detector.
- **Sessions without an adopted `sessionId`** have no transcript watch and so no chat content, but their
  dialogs are watched from the screen (§ 5, `39d60fd`). Adoption depends on the registry / title
  announcement; a pane that never gets one stays on "connecting" in chat view, with an empty log.
- **Large transcripts.** A very large file was backfilled in under four seconds in a read-only trial, but
  every item becomes a DOM node (markdown is rendered per message); there is no virtualisation. Memory and
  scroll cost with very long sessions is **unmeasured**.
- **`/clear` and forking resumes** are followed by re-asking the process tree, bounded to three attempts
  per watch; a miss leaves the view on the old session until the next trigger.

**Open questions**

1. Should the detector learn first-run offers that have no footer to anchor on (the "make auto mode your
   default" one)? Nothing else points the operator at the terminal for them, since the stalled-turn notice
   needs an open turn.
2. Is 20 s the right threshold for the stalled-turn notice, and should it differ for long tool runs?
3. *(answered)* The tool's output now sits behind a disclosure in each row. Open: should the row open on its
   own for an error, or for the tool that is blocking a turn?
4. Should `chatViewDefault` be per agent or per pane kind rather than global?
5. Is a version guard on the transcript format worth having (warn when no `user`/`assistant` line was
   recognised in a non-empty file)?

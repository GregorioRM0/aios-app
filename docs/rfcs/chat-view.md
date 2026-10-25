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

It is a prototype: it proves the loop on a real session end to end (§ 10 lists what it does not do).

## 2. What it does for the operator

Every pane that runs Claude gets the switch; panes that run anything else (a shell, a viewer, a session
that has ended) do not.

- **Toggle, three doors.** A small icon on the pane's tab; *File → Switch Between Terminal and Chat*
  (`CmdOrCtrl+Shift+L`, acting on the focused or active pane); a row in the tab's context menu. Inside the
  chat view a `Terminal | Chat` switch in the header goes back. Flipping creates no pane and no pty.
- **Open in chat by default.** Settings → `chatViewDefault` (off unless the stored value is literally
  `true`). It is read fresh on each pane creation, so it covers new, restored and resumed sessions — all of
  them go through `createPane` with a `claude` command.
- **Bubbles.** The operator's messages and Claude's replies, the latter as markdown rendered once the
  message is complete (code highlighted). Notes for system events: an interruption, an API error, the
  output of a local command.
- **Tools collapsed.** Each tool call is one line (`name · what it is about`) with a running / ok / error
  state that updates in place when the result arrives. No tool output is shown.
- **Activity indicator.** A "working" line while a turn is open and the pty has produced output recently,
  or a message was just sent.
- **The box.** Enter sends; Shift+Enter inserts a newline; IME composition never sends. Esc cuts the
  running turn (only while something is running — see § 3). Slash commands are sent like any other
  message, with no filter and no special path.
- **Font and size.** The same pickers as before, persisted through the existing `chatFontFamily` /
  `chatFontSize` settings and shared by every chat view.
- **Usage bar.** 5-hour, weekly, context, model, effort. See § 6 for which of these belong to the pane
  and which to the account.
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
- *pty output tail* (`src/core/tuiPrompt.ts`, pure). Only to notice that the TUI is waiting on a dialog
  (§ 5).
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

**Lifetime of a watch.** Created by `chatSkin:watch`; ended by `chatSkin:unwatch`, the pty's exit (after
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

`ChatItem = {uuid, role: 'user'|'assistant'|'tool'|'system', text?, tool?: {id, name, summary, status: 'running'|'ok'|'error'}, ts?}`.
Details the renderer relies on:

- During a backfill only `items` are streamed; `turn` and `usage` are announced **once** when it ends,
  so a long history does not flicker the indicator.
- A tool item uses the `tool_use` id as its `uuid`; when the result arrives the same `uuid` comes again
  with `ok` or `error`. A tool still running when the transcript records an interruption is marked `error`.
- `prompt` is sent only when the kind *changes*; `null` means the dialog is gone.
- Absent numbers stay absent, never `0`.

IPC surface: `chatSkin:watch(paneId, sessionId) → {ok:true, file} | {ok:false, error:'not-found'|'bad-id'}`
(`not-found` does not stop the search), `chatSkin:unwatch(paneId)`, the `chatSkin:event` stream, and
`chat:status` for the usage bar. The `sessionId` becomes part of a path, so anything not shaped like an id
(`/^[A-Za-z0-9-]{8,}$/`) is refused before it is joined.

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

**Detection** (`detectTuiPrompt`, pure; `createPromptMonitor` wraps it). Main feeds the monitor the raw pty
output of a watched pane (bounded tail of 16 KiB; judged 120 ms after output settles, because a TUI repaints
a dialog in many small writes). A verdict needs *structure*, not wording, because ordinary answers are full
of numbered lists and sentences like "Do you want to proceed?":

1. a numbered option list (consecutive, at least two) with the TUI's selection cursor `❯`, whose last option
   is within five non-empty lines of the end of a 40-line tail (a dialog is the last thing painted);
2. a recogniser around it that only the TUI prints — trust, model picker, question chips / "Type something",
   permission wording — or, for an unrecognised but real menu, the TUI's own footer (`Enter to select`,
   `Esc to cancel`);
3. kinds: `permission · trust · select · question · model · other`; `other` is deliberately narrow (a
   keypress prompt such as `(y/n)` on the very last lines). The `hint` is the question line, trimmed.

**What the operator sees.** A non-null `prompt` puts `cs-strip` on the pane: the overlay shrinks to the
upper part and the **real xterm** is un-hidden in the lower strip (so the TUI's bottom rows, where the
dialog is drawn, are visible) and takes the focus. A notice (`role="alert"`) says what is being asked. The
box is disabled for the duration. If the pane is not in front or the window is hidden, the tab is marked
and a toast says which session needs the operator. When the dialog goes (`kind: null`) the strip closes and
the caret returns to the box.

**When the dialog is considered answered.** The pty output moving past it, or *proof from the transcript*:
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
- **From reading the code, not tested:** the monitor exists only while a transcript watch exists, and a
  watch needs an adopted `sessionId`. So a dialog shown *before* adoption (the first-run folder-trust prompt
  is the obvious case) is not seen by the monitor, and a dialog already on screen when the operator flips
  to chat starts with an empty buffer until the TUI next paints. The state shown meanwhile is "connecting",
  and the stalled-turn net needs an open turn. Whether another path covers these cases is **pending** to
  verify (§ 10).

## 6. The usage bar: what is the pane's and what is the account's

`~/.claude/statusline-payload.json` is the last payload written by **any** Claude Code session on the
machine. It is global, not per tab. Therefore:

- **5-hour and weekly percentages are the account's** numbers (the most recent session's reading of them),
  which is what they are in Claude Code too; they do not belong to this pane. Effort is also read from the
  payload and is likewise not guaranteed to be this pane's.
- **Context and model of the pane come from this session's own transcript** (the `usage` event) whenever
  it has them: the context shows as tokens (for example `84k`), the model overrides the payload's. The
  payload only fills what the transcript cannot say, field by field.
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

**What was reused** (it lives in `renderer/app.js` between `CHAT SKIN` and `END CHAT SKIN`): the bubbles;
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
- **End-to-end gate in the smoke run — pending.** *Specification, not yet verified against the tree:* an
  extra step of `npm run smoke`, enabled by `AIOS_SMOKE_CHAT=1`, running in the hidden window the smoke
  already uses (`show: false`), that goes session → chat view → message → bubble. It needs a real `claude`,
  so it starts an **ephemeral session in a temporary cwd that closes and cleans itself up**, and reports
  `SKIPPED` (like the discovery gate) when no `claude` is on the machine. It is run only through
  `npm run smoke` and never with a visible window: the repository's rule is that no check opens a window
  on the operator's screen (`npm start`, `--eval` and `--shot` are not used to verify this feature). As of
  this commit the step is **not in the branch**; this paragraph must be reconciled with the code when it
  lands.
- **Gates for a change like this:** `npm test`, `npm run smoke`, `npm run check:tokens` (no colour
  outside `theme.css`; every pty submit goes through `submitToPty`), `npm run check:whatsnew`.
- **What source-reading tests cannot see:** that the bubbles actually paint and the strip actually shows.
  That was checked by hand in a hidden window with a throwaway harness kept outside the repo, so it is
  not reproducible from the tree until the smoke step above exists.

## 10. What it does not do yet, and risks

**Not done**

- **Partial streaming.** Messages appear when complete, as the transcript records them.
- **Tool output** is not shown, only that a tool ran and how it ended.
- **Thinking and subagent activity** are not shown (subagent lines are dropped on purpose).
- **Answering dialogs** from the chat; they are only pointed at (§ 5).
- **Attachments, images, drag-and-drop, `@` mentions** in the box.
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
- **Sessions without an adopted `sessionId`** have no watch and so no chat content and no dialog detection
  (§ 5). Adoption depends on the registry / title announcement; a pane that never gets one stays on
  "connecting" in chat view.
- **Large transcripts.** A very large file was backfilled in under four seconds in a read-only trial, but
  every item becomes a DOM node (markdown is rendered per message); there is no virtualisation. Memory and
  scroll cost with very long sessions is **unmeasured**.
- **`/clear` and forking resumes** are followed by re-asking the process tree, bounded to three attempts
  per watch; a miss leaves the view on the old session until the next trigger.

**Open questions**

1. Should a dialog before `sessionId` adoption (first-run trust) be covered by watching the pty from the
   moment a chat view opens, independent of the transcript watch?
2. Is 20 s the right threshold for the stalled-turn notice, and should it differ for long tool runs?
3. Should the chat offer the tool's output behind a disclosure, now that it is available in the transcript?
4. Should `chatViewDefault` be per agent or per pane kind rather than global?
5. Is a version guard on the transcript format worth having (warn when no `user`/`assistant` line was
   recognised in a non-empty file)?

# RFC: Chat view — a conversation pane beside the terminals

- **Status:** Prototype, for discussion
- **Scope:** AIOS App (this repo). No framework change.
- **Code references:** `feat/chat-view`, branched from 0.12.0

## 1. Summary

The app's only way to talk to Claude is a terminal. That is the right default (*Glass, not engine*:
the real `claude` CLI in a real pty), but a terminal is a poor reading surface for an operator who
never opens an editor: no readable prose, no font choice, no way to see "how much have I used" without
leaving the screen.

This prototype adds a second kind of pane, **Chat**: a persistent Claude Code session shown as
bubbles, with streaming text, an approval card for each permission request, Stop (button or Esc),
a font and size picker, and a usage bar (5-hour, weekly, context, model, effort). It opens from
*File → Open Chat*, the (+) menu, or the button beside the (+). The terminal is untouched.

It is a prototype: it proves the loop works end to end (§ 7 lists what it does not do).

## 2. What it does

Open a chat and a session starts where a primary terminal would — the vault root (else `~/aios`) —
as the primary session, and its first message is `Start session`, so the vault's own start-of-session
ritual runs exactly as it does in a terminal. From there:

- the reply **streams** into a bubble and is rendered as markdown once complete (code is highlighted);
- tool calls appear as one-line notes;
- a tool that needs approval raises a **card** (Allow / Deny, with the raw input behind *Details*);
- **Stop** or **Esc** interrupts the turn; any approval still waiting is denied;
- the **usage bar** shows the numbers, and `—` where a number is unknown;
- closing the tab, the window or the app closes the session.

## 3. Architecture

```
renderer (chat pane)  ──glassShell.chat*──▶  preload  ──ipc 'chat:*'──▶  main (chatSession.ts)
        ▲                                                                   │  Agent SDK query()
        └────────────── 'chat:event' (ChatEvent) ◀──── chatEvents.ts ◀──────┘  └─ spawns `claude`
```

- **The SDK lives in main.** `src/main/chatSession.ts` owns one `query()` per chat, with a small
  async queue as its input so the session stays alive across turns. It imports neither `electron`
  nor `./aios`: everything it needs (`cwd`, `env`, the claude command, the statusline path) is
  injected by `main.ts`, which keeps it runnable under plain node and leaves `main.ts` as the one
  place that knows about windows and IPC.
- **`canUseTool` over IPC.** Every request the CLI would have asked the operator becomes a
  `permission` event with a fresh `requestId`; the promise stays open until the renderer answers
  (`chat:permission`). Interrupt, close, exit and the SDK's own abort all resolve what is still
  pending as *deny* and emit `permission-resolved`, so a card can never outlive its question.
- **The event contract** (`src/core/chatEvents.ts`, pure — no electron, no fs):
  `ready · turn-start · delta · turn-end · tool · permission · permission-resolved · result · status · error · exit`,
  each tagged with the chat `id`. A *turn* is one assistant text block, opened on its first text
  (so a message that only calls tools leaves no empty bubble) and closed with the complete text,
  which replaces whatever the deltas built. `error` carries a stable `code` the renderer words
  through i18n and the raw `message` as detail.
- **Where the usage numbers come from.** The live session first (plan usage from the SDK's
  rate-limit events, context from message usage and the result's model window, model from the
  init message); `~/.claude/statusline-payload.json` — the last payload Claude Code's status line
  wrote — fills what the session cannot know. Merging is field by field, and an absent field stays
  `undefined`: nothing here defaults a percentage to 0, because a bar that shows `0%` for a
  missing number is a fabricated reading. The file is the last payload written by *any* session on
  the machine, which is why it is only ever the fallback.
- **Renderer.** `openChatPane()` in `renderer/app.js`, one global event router keyed by chat id,
  colours only through `--chat-*` tokens (defined for both themes), every string through `t()`.

## 4. Decisions

| Decision | Why |
|---|---|
| **Agent SDK, not `claude -p`.** | The SDK gives permission requests as a callback, interrupts, multi-turn input and structured partial messages. `-p` with stream-json can stream, but approvals and Stop would have to be re-implemented over its control protocol — which is what the SDK is. The CLI fallback was never needed; the translator also accepts raw stream-json lines, so it stays possible. |
| **Run the operator's own `claude`.** | `resolveClaude(claudeCmd)` finds the first word of *Settings → Claude CLI command* on `PATH` plus the usual install folders (a Dock-launched app has a minimal `PATH`). Same binary, same version as the terminals. The SDK's bundled binary is only the fallback. Extra arguments in the command are not carried over — the SDK builds its own. |
| **Session with `termEnv`'s environment.** | The chat uses the same `termEnv(undefined, primaryName())` a terminal does, so `CLAUDE_AGENT_NAME` and the session-persistence flags are identical. A parallel env would drift from the terminals one flag at a time. |
| **Honour the operator's settings.** | The SDK loads user, project and local settings, and the session uses the system prompt preset the CLI runs with. So the chat obeys the operator's `defaultMode`: **with `bypassPermissions` no approval card ever appears**, exactly as in a terminal. This was observed, not assumed (§ 6). |
| **`Start session` as the first message.** | It is what the operator types in a terminal; the vault's rituals key off it. It is optional in the contract (`startSession`), so a different opener can start a bare session. |
| **Markdown is untrusted.** | Model output can quote a web page or an email, and this renderer holds the whole `glassShell` bridge. Two independent guards: a *private* `marked` instance whose `html` renderer escapes raw HTML (the global one renders vault notes), then an allowlist pass over an inert `<template>` that drops attributes and non-http(s)/mailto links. Either alone would do today; both exist because a parser upgrade is when a guard goes missing unnoticed. |
| **Stop denies what is parked.** | A turn blocked on an approval cannot hear an interrupt, so the pending requests are denied first. |
| **No new accelerator.** | Every free ⌘/⌘⇧ letter is spoken for; the pane has three doors that need no key. |

## 5. node_modules and the dependency

`@anthropic-ai/claude-agent-sdk` is pinned to an exact `0.3.310` (a 0.x tied to a native binary). It
pulls a large `package-lock.json` diff: its peer dependencies and one optional package per platform
(`build.asarUnpack` also unpacks it, since a native binary cannot run from inside the asar —
**not verified: no `.dmg` was built**).

In this worktree `node_modules` was a symlink to the other clone's. Installing the SDK replaced it with
a real directory (the SDK is not in the shared one, which was left untouched). Consequences, so the
next person is not surprised: the worktree now has its own Electron (`node_modules/electron/dist`),
and `node-pty`'s `spawn-helper` needed `chmod +x` (the `posix_spawnp failed` described in
`CONTRIBUTING.md`). `node_modules` is gitignored and was not committed.

## 6. How it was verified

- `npm test`, `npm run smoke`, `npm run check:tokens`, `npm run check:whatsnew` green.
- `src/test/chatView.test.ts`: channel parity between preload and main, an event handler in the
  renderer for every event main can emit, env/cwd/primary wiring, `Start session`, pending-approval
  denial, Enter / Shift+Enter / IME, markdown sanitising, settings whitelist, i18n parity, and unit
  tests of the usage parsing and merge and of the translator.
- By hand against the real app on an isolated profile (`npm run start:isolated`, driven over the
  DevTools protocol): the session started with `Start session`, the reply streamed, Stop and Esc
  ended a running turn, the usage bar filled and updated after each turn, closing the tab ended the
  `claude` child.
- **Approvals were exercised against the main bridge, not through the pane.** The development
  machine's settings say `bypassPermissions`, so no card is ever raised there; a one-off script
  forced `permissionMode: 'default'` (the optional `ChatDeps.permissionMode`, unused by the app) and
  confirmed allow (the file was written), deny (it was not), and that an interrupt or close with a
  request parked resolved it as *deny* and wrote nothing. The card's markup and click wiring was
  checked in the renderer with simulated events.

## 7. What is missing

- **Persistence.** A conversation dies with its tab; there is no resume or history list. The
  `sessionId` is already in `ready`, so resuming is a small step.
- **Attachments, images, drag-and-drop**, and slash commands / `@` mentions.
- **Several chats at once** work mechanically (ids are per session) but are untested at volume, and
  there is no per-chat naming.
- **Error wording.** The SDK's own error text is shown as detail, untranslated.
- **A permission mode picker.** The chat follows the operator's settings; it cannot be changed from
  the pane.
- **Thinking and subagent activity** are not shown (subagent messages are ignored on purpose).
- **Tool results** are not shown, only that a tool ran.
- **The packaged build** is unverified (`asarUnpack`, the fallback binary, notarisation of a nested
  native binary).
- **Accessibility pass** on the log and the card beyond the `role="log"` basics.
- **Cloud mode.** The session runs in the app's main process; moving it behind a host is the
  cloud-mode RFC's concern, and this bridge's injected dependencies are the seam for it.

## 8. Alternatives considered

- **Parsing the terminal.** Scraping a pty's screen for bubbles is what this exists to avoid.
- **`claude -p` per turn.** Loses the live session (context, hooks, approvals) between turns.
- **A web view of an external chat UI.** Not the operator's vault, settings or identity.

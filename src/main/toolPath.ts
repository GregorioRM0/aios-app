/* #72 — App-launched sessions get the folders a login shell would have added to PATH.
 *
 * Opened from Finder or the Dock, the App inherits launchd's minimal PATH (/usr/bin:/bin:…).
 * Homebrew's /opt/homebrew/bin reaches a terminal through `brew shellenv` in ~/.zprofile, which
 * a session the App launches never sources. So `uv` — installed by the App's own setup — was
 * "command not found" in every session it opened, and a hook probe that prints nothing read as
 * a clean result. Measured: `command -v uv` empty in the session, `zsh -lc 'command -v uv'`
 * → /opt/homebrew/bin/uv on the same machine at the same moment.
 *
 * APPENDED, never prepended, and only folders that exist and are not already there: whatever
 * order the operator's PATH already has wins, and nothing an operator did not install appears.
 * Pure over the `exists` it is handed, so it is tested without touching the real filesystem. */
import * as path from 'node:path';

export function toolDirs(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return [];
  const brew = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : ['/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin'];
  return [...brew, path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin')];
}

export function withToolDirs(envPath: string | undefined, home: string, platform: NodeJS.Platform,
  exists: (dir: string) => boolean): string {
  const have = (envPath || '').split(':').filter(Boolean);
  const add = toolDirs(home, platform).filter((d) => !have.includes(d) && exists(d));
  return [...have, ...add].join(':');
}


/** Desktop runtime data directory: independent from the CLI's `~/.dsh`. */

import { homedir } from 'node:os'
import { join } from 'node:path'

const ENV_HOME = 'DSH_STUDIO_HOME'

/** Resolve the DSH Studio product home, honoring the explicit override. */
export function resolveStudioHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[ENV_HOME]
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'DSH Studio')
  if (process.platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'DSH Studio')
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'dsh-studio')
}

/** The Harness home inside the Studio product home. */
export function resolveHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStudioHome(env), 'harness')
}

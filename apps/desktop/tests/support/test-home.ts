/* oxlint-disable typescript/no-unsafe-assignment -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-call -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-member-access -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-argument -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unsafe-return -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-redundant-type-constituents -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-type-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-non-null-assertion -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */
/* oxlint-disable typescript/no-unnecessary-condition -- raw desktop IPC and process fixtures are deliberately narrowed by hand. */

import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const FIXTURE_PACKAGE = join(REPO_ROOT, 'packages', 'test-support', 'desktop-runtime-fixture')
const PROFILE_MODULES = join('profiles', 'desktop', 'node_modules', '@deepseek-ai')

/**
 * Create a fresh DSH Studio test home and install the deterministic fixture
 * package into the desktop profile's resolution path. This symlink is test
 * scaffolding only; production profiles resolve installed packages normally.
 */
export function createDesktopTestHome(prefix = 'dsh-desktop-runtime-'): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  installDesktopFixture(home)
  return home
}

/** Install (idempotently) the fixture package into one profile home. */
export function installDesktopFixture(home: string): void {
  const link = join(home, PROFILE_MODULES, 'dsh-desktop-runtime-fixture')
  if (!existsSync(link)) {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(FIXTURE_PACKAGE, link, 'dir')
  }
}

/** Patch overlay adding the deterministic runtime fixture tools. */
export function desktopTestPatchPath(): string {
  return join(REPO_ROOT, 'apps', 'desktop', 'tests', 'fixtures', 'desktop-test.patch.yml')
}

/** Built desktop-profile CLI used by every runtime E2E child. */
export function desktopCliEntry(): string {
  return join(REPO_ROOT, 'apps', 'cli', 'lib', 'bin.js')
}

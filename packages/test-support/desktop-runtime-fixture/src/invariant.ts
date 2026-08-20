/**
 * Package-owned invariant companion for the desktop runtime fixture package.
 * @module @deepseek-ai/dsh-desktop-runtime-fixture/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-desktop-runtime-fixture'

/** Cordis companion plugin name. */
export const name = 'desktop-runtime-fixture-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this fixture package owns no Cordis event stream or
 * shared data; its tools are exercised through the desktop runtime E2E path.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

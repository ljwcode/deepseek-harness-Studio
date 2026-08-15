# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

The dsh desktop-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it pins the native directory picker, mounts the API gateway, plugin inventory, storage, workspace, and the full existing client UI roster, and replaces the Web HTTP/WebSocket carrier with `connection-desktop` plus the desktop runtime and IPC rows. It mounts no webserver, frontend-static, web-startup, or Web connection row.

`runtime` scans the composed `dsh.client` roster into the boot graph returned to the renderer, and reads built client bundles over IPC. `ipc` is inert unless Electron main sets `DSH_DESKTOP_IPC=1`; when enabled it answers bootstrap, ping, bundle, and fetch requests against `ctx.apiProxy` and the transport-independent `ctx.connection` registry.

## Model Experience

Indirectly, through the system-prompt persona restated by this bundle; every other model-visible effect belongs to the row packages the patch mounts.

#### KV Cache effect

The restated persona changes only the fixed deployment prompt text; no per-request or per-session token content is added by this package.

## Known Limitations and Deferred Work

- **Bundle hashes are read on every bootstrap** — the runtime deliberately re-scans instead of caching; client HMR is disabled and plugin changes take effect after a Harness restart.
- **Desktop data layout is not migrated yet** — the Electron shell points `DSH_HOME` at the Studio home, but importing an existing CLI profile is deferred.

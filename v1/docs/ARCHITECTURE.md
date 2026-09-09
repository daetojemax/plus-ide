# Plus v1

One shared chat = one local project directory. Node.js owns collaboration, permissions, persistence and the Codex adapter. Tauri owns the native shell, folder chooser and private owner bootstrap. React renders the same chat in Tauri and in a guest browser.

## First working slice

- [x] Tauri desktop with React/Vite and native folder selection.
- [x] Fastify + authenticated HTTP/WebSocket + SQLite.
- [x] Project creation, persisted team messages and image attachments.
- [x] One-time chat invitations, scoped guest sessions and revocation.
- [x] Real Codex App Server adapter, queued tasks, streaming, cancellation and owner approvals.
- [x] Read-only Git inspection and settings for the public Funnel URL.
- [x] Backend integration tests, browser verification and native build.

## Boundaries

The owner credential is only available via native IPC (or a local development file). It never appears in an invitation, static bundle or unauthenticated endpoint. Guest sessions are scoped to one project. WebSocket subscriptions use the same session checks as HTTP. Browser mutations require matching Origin and a custom header. Files are addressed by database IDs, never arbitrary guest paths. The public API cannot execute shell commands directly.

Codex runs per project over private stdio, with explicit read-only/workspace-write sandbox and on-request approvals routed to the owner. Members can submit tasks; only the owner selects edit access, configures projects, grants elevated approvals or changes public URL. Unknown agent approval methods fail closed. Worktree isolation and branch publishing are subsequent features; v1 visibly uses the attached directory and read-only agent mode by default. Git worktrees would separate file edits, not provide a security sandbox.

Messages, tasks and replay events are durable SQLite records. Delta events are transient; completed agent messages are durable. On backend restart active tasks become failed and queued tasks become cancelled, rather than silently repeating external side effects. The UI can explicitly retry. The scheduler serializes work per project and prevents duplicate directory registrations.

The desktop bundle contains its own Node runtime and Codex CLI (locked by package-lock.json), so it does not depend on the globally installed CLI version. The backend runs only while the desktop app is open.

## Reference and visual direction

Reference: https://github.com/Dimillian/CodexMonitor (MIT). Studied workspace sidebar, app-server orchestration and three-pane layout. Plus implementation is original and uses a Node backend, rather than copying the reference Rust backend.

`design-concept.png` is a generated implementation reference: charcoal sidebar, dark navy chat, right inspector, green active indicator, 1px borders, system typography (13px chrome / 14px message / 26px empty heading), restrained 8–12px radii. No raster graphics are used as UI. Exact core copy: «Новый проект», «Проект», «Изменения», «Пригласить», «Над чем поработаем?», «Обсуждайте проект вместе. Поручайте задачи агенту.», «Изучить проект», «Проверить изменения». Empty initial state intentionally has no seeded projects or fake participants. The inspector, invite dialog and settings extend this same visual system. Mobile uses drawers for the side panels.

The implemented desktop was compared with the concept at 1536 × 1024:

- The three-pane hierarchy is retained; sidebars use fixed widths and the chat fills available space.
- Charcoal/navy surfaces, mint accents and fine borders match the visual direction.
- System typography preserves the heading/body hierarchy, with slightly denser desktop controls.
- The empty-state text and two suggestion cards are retained; the composer stays at the bottom.
- The inspector uses real project paths and participants. Owner controls are hidden for guests; small screens use drawers instead of shrinking three columns.

## Local bundle signing

Tauri signs the app and its sidecars with an ad hoc identity for local use. `Entitlements.plist` enables `com.apple.security.cs.allow-jit`, required by the bundled Node/V8 runtime under Hardened Runtime. Without it, the signed Node process traps during `pthread_jit_write_protect_np`. See [Apple's JIT guidance](https://developer.apple.com/documentation/Apple-Silicon/porting-just-in-time-compilers-to-apple-silicon) and [Tauri entitlements configuration](https://v2.tauri.app/distribute/macos-application-bundle/#entitlements). A valid local signature does not imply notarization or distribution readiness.

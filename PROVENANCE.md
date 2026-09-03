# Provenance

The reconstruction is based on the public macOS arm64 release artifact:

- Product: Grok Bot
- Version: 0.18.0
- Upstream bundle ID: `com.anysphere.sand`
- Electron framework: 42.1.0
- DMG URL: `https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.18.0/Grok_Bot_0.18.0.dmg`
- DMG SHA-256: `a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb`
- Original `app.asar` SHA-256: `6665408168466f9cacc6087e917890c17f59d2e2e9c2404a5c4a59ad79c1de58`

The repository preserves the original macOS artifact above and the matching
Windows x64 installer through Git LFS. The Windows artifact identity is:

- Installer URL: `https://downloads.cursor.com/grokbot/stable/win32-x64/0.18.0/Grok_Bot_0.18.0_Setup.exe`
- Installer SHA-256: `464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e`
- Preservation manifest: `research-archives/original/0.18.0/artifacts.json`

The original application was Developer ID signed and notarized by Anysphere
Incorporated. Reconstructed builds are intentionally given a different bundle
ID and only ad-hoc signed; they do not retain or claim the upstream signature.

## Web renderer provenance (0.36.0)

The web/Dokploy runtime (`deploy/control/shipped-renderer`) ships the stock
renderer of a second pinned public release:

- Product: Grok Bot
- Version: 0.36.0
- Upstream bundle ID: `com.anysphere.sand`
- Electron framework: 42.1.0
- DMG URL: `https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.36.0/Grok_Bot_0.36.0.dmg`
- DMG SHA-256: `5aacc48244fea0a99d56d5d0a0748a71de5514cf2e0e11b4934f56aae53b48a6`
- `app.asar` SHA-256: `2ae381b92f9f19dd33b2404b512cedaa3d2e1b4a08640be088dc6a06b1cf98d3`
- Preservation manifest: `research-archives/original/0.36.0/artifacts.json`
- Renderer inventory: `deploy/control/shipped-renderer-provenance.json`
  (per-file SHA-256; verified by `npm run web:bootstrap`)

The desktop 0.18.0 pins above are unchanged by this second renderer; the web
pins live beside them in `scripts/lib/config.mjs` (`web*` constants).

Evidence anchors for the web renderer transform
(`scripts/lib/router-renderer-patch.mjs`, mode
`original-renderer-036-settings-extension`, recorded per file in
`dist/renderer/renderer-router-extension.json` inside each web build):

- the 0.36.0 settings surface is catalog-driven: the entrypoint map (module
  `y2`), settings registry (`iC`), and the build-time module-graph tables
  (`/src/electron-renderer/features/settings/overlay/**/entrypoint.ts` and
  their `view.tsx` loaders) inside the main chunk are inspectable artifact
  anchors; the patch adds a `router` entrypoint, registry entry, and lazy view
  following exactly those shapes;
- the Router page component ships as a separate chunk
  (`chunk-view-router-patch1.js`) written at web-build time and importing only
  exported design-system members (`c`, `j`, `r`, `ax`, `B`, `aF`, `O`, `w` from
  the main chunk; `G`, `a` from `chunk-settings-row-*`; `S` from
  `chunk-scroll-pane-*`);
- the composio Gmail routine trigger reuses 0.36.0's own trigger factories in
  the main chunk (platform defaults `FMt`, form-load `iKe`, form-save `oKe`,
  sentence builders `WMt`/`OKe`) and the routine editor chunk (platform menu
  item, row glyph `In`, fields switch `Cn`), each patched by exact-once string
  anchors recorded in the extension provenance.

The shipped renderer contained optimized production bundles, not the authored
frontend source or source maps. The readable `frontend/` tree is therefore a
partial evidence-backed reconstruction, while packaged builds retain the pinned
renderer and apply only a narrow, hash-recorded settings transform.

No upstream source-code license is implied. Do not present reconstructed
material as original source or an official build, and complete an independent
rights review before public redistribution.

## Evidence-only reconstruction rule

The immutable release is the product specification. Recovered source may express
only behavior supported by at least one inspectable artifact anchor: emitted code
or source-path markers, extracted capsules/source maps, shipped strings/assets/CSS,
renderer DOM signatures, IPC/RPC contracts, or repeatable observation of the
shipped runtime.

This rule is especially strict for the renderer. Do not invent or redesign a
screen, route, control, label, selector, state, or interaction to fill an evidence
gap. A clean abstraction or test seam is acceptable only when it preserves
artifact-derived semantics and does not add product behavior. When evidence is
incomplete, record the uncertainty and leave the feature unmapped or
evidence-only instead of guessing.

Every UI-facing recovery must identify its artifact anchor in its evidence
catalog, focused test, or coverage note. Passing typecheck/build alone is not
proof of provenance; speculative behavior is a release-blocking defect.

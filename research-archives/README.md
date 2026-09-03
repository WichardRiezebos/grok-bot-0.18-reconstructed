# Original release archive

This directory preserves the publicly distributed Grok Bot installers used by
the reconstruction. The large binaries are tracked with Git LFS.

- `0.18.0/` — the pinned desktop macOS/Windows release the reconstruction
  targets.
- `0.36.0/` — the pinned public release whose renderer ships the web/Dokploy
  app (`deploy/control/shipped-renderer`).

## Artifacts

### 0.18.0 (desktop reconstruction)

| Platform | Architecture | Bytes | SHA-256 | Original URL |
| --- | --- | ---: | --- | --- |
| macOS | arm64 | 155,793,020 | `a253ccd8aab01e083f9812a0264354c5034d8ba7f0610bbb557e82ae77d203eb` | `https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.18.0/Grok_Bot_0.18.0.dmg` |
| Windows | x64 | 125,825,552 | `464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e` | `https://downloads.cursor.com/grokbot/stable/win32-x64/0.18.0/Grok_Bot_0.18.0_Setup.exe` |

### 0.36.0 (web/Dokploy renderer)

| Platform | Architecture | Bytes | SHA-256 | Original URL |
| --- | --- | ---: | --- | --- |
| macOS | arm64 | 140,303,488 | `5aacc48244fea0a99d56d5d0a0748a71de5514cf2e0e11b4934f56aae53b48a6` | `https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.36.0/Grok_Bot_0.36.0.dmg` |
| Windows | x64 | 115,387,280 | `01b6c8810f168fdc0ca9701a4add9c26ff3d9a9ca800729f5c7cd412f5d31122` | `https://downloads.cursor.com/grokbot/stable/win32-x64/0.36.0/Grok_Bot_0.36.0_Setup.exe` |

The 0.36.0 macOS `Contents/Resources/app.asar` is pinned separately as
`2ae381b92f9f19dd33b2404b512cedaa3d2e1b4a08640be088dc6a06b1cf98d3`; the
committed web renderer in `deploy/control/shipped-renderer` is verified
file-by-file against `deploy/control/shipped-renderer-provenance.json`, which
records that asar identity.

The browser download metadata on the archived local copies identified the URLs
above. The macOS checksums also match the independent pins used by the build
toolchain.

## Fetching and verification

```sh
git lfs install
git lfs pull
(cd research-archives/original/0.18.0 && shasum -a 256 -c SHA256SUMS)
(cd research-archives/original/0.36.0 && shasum -a 256 -c SHA256SUMS)
```

`artifacts.json` is the machine-readable source, size, and digest inventory.
These files are preservation inputs, not reconstructed build outputs.



<!-- CODEGRAPH_START -->
## CodeGraph

Indexed means **`.codegraph/codegraph.db` exists**. A committed `.codegraph/.gitignore` stub is not an index.

Reach for CodeGraph **before** grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. Treat that source as already Read — do not re-open those files.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.
- **Flows:** name both ends (`authenticate useSession`).
- **Do not** re-verify CodeGraph with repo-wide grep. After edits, trust the staleness banner and Read only the listed files.
- Full query cookbook: company `codegraph` skill.

If the tool says the project is not indexed: run `codegraph init` (or wait for the plugin toast). **Do not** switch to repo-wide grep for the rest of the session.

While the index is building, glob/grep **only inside the module from the ticket** (for example `erp/astro/src/modules/inspections`). No unscoped `*.{ts,tsx}` greps in a monorepo. Cap grep results. Do not re-read the same file over and over.
<!-- CODEGRAPH_END -->

<!-- ORCA_BROWSER_START -->
## Orca browser

When testing in Orca's embedded browser:

- Open **this worktree's** stack URL (from `make status` / `.stack/STATUS`). Never another ticket's `erp.NNN.groem.localhost`.
- Loop: `orca goto --url …` → `snapshot` → `click --element @eN` → `snapshot`. Do not `eval` to scrape the page. If refs are empty or generic, take **one** `orca screenshot` and ask — do not start an innerText loop.
- Use typed commands from `orca skills get orca-cli`. Do not guess `exec` or flags (`--timeout-ms`, `viewport`).
- Phone: `orca emulator …`, not CSS width hacks.
- After 2 screenshot timeouts ("tab not visible"), stop and tell the user to keep the Orca window focused. Do not retry 6 times.
- `console` / `network` only when diagnosing a specific failed request, never as a default after a test.
<!-- ORCA_BROWSER_END -->


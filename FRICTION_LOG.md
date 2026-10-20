# Friction Log

## 2026-10-21 — Turso CLI unavailable on Windows
- **Task:** Create free cloud SQLite database
- **Expected:** `turso db create` works after install
- **Actual:** `'turso' is not recognized` — CLI requires WSL on Windows
- **Severity:** Medium
- **Workaround:** Created database via turso.tech web dashboard + SQL editor
- **Suggestion:** Document a browser-only path for Windows users

## 2026-10-21 — MCP Inspector connection issues on Windows
- **Task:** Connect Inspector to `http://localhost:8081/mcp`
- **Expected:** `--url` flag connects directly
- **Actual:** "Failed to connect to the URL"; `--cli` mode requires `--method` and doesn't open the UI
- **Severity:** Medium
- **Workaround:** Started Inspector with no flags, entered URL manually in the UI
- **Suggestion:** Clarify that `--url` and `--cli` are different modes; UI manual entry is reliable

## 2026-10-21 — Git pushing as wrong GitHub account
- **Task:** Push repo to github.com/abhishekingle9090-debug
- **Expected:** Push succeeds
- **Actual:** `Permission denied to tanujaingle` — Windows Credential Manager held stale credentials
- **Severity:** High (blocked delivery)
- **Workaround:** Cleared `git credential-manager erase` + re-authenticated via browser as the correct account
- **Suggestion:** Include credential-reset step in setup docs

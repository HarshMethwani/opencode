# 02 — Remaining Rebranding Work

## What's Already Renamed

| Item | Status |
|------|--------|
| Package names (@opencode-ai/* → @quillshield/*) | Done in core, NOT in ui/desktop/sdk |
| Binary name (opencode → quillshield) | Done |
| Global app name | Done |
| Config filenames (opencode.json → quillshield.json) | Done |
| Config directories (.opencode → .quillshield) | Done |
| System prompt router | Done |
| MCP client name | Done |
| User agent string | Done |
| Root package.json | Done |
| turbo.json | Done |
| CI workflow files | Done |
| nix config | Partially done (paths updated, metadata not) |

## What Still Needs Renaming

### Tier 1: Breaking (build won't work)

1. **packages/ui/src/** — 80+ files still import `@opencode-ai/*`
2. **packages/desktop/vite.config.ts** — imports `@opencode-ai/app/vite`
3. **packages/sdk/js/** — example and scripts import `@opencode-ai/*`

### Tier 2: User-Visible Strings

1. **Desktop app branding**
   - `packages/desktop/src-tauri/tauri.conf.json`: productName "OpenCode Dev" → "QuillShield", identifier `ai.opencode.desktop.dev` → `ai.quillshield.desktop`, mainBinaryName "OpenCode" → "QuillShield"
   - `packages/desktop/src/index.tsx`: deep link protocol `opencode:deep-link` → `quillshield:deep-link`
   - `packages/desktop/src/menu.ts`: URLs to `opencode.ai` → new domain (or remove)

2. **HTTP Headers** (in `packages/quillshield/src/session/llm.ts`):
   - `x-opencode-session` → `x-quillshield-session`
   - `x-opencode-request` → `x-quillshield-request`
   - `x-opencode-client` → `x-quillshield-client`

3. **CLI help text & error messages** — scattered throughout `packages/quillshield/src/cli/`
   - Strings like "opencode auth login", "opencode mcp auth", etc.
   - Error messages referencing "opencode.json"

4. **Nix config metadata** (`nix/opencode.nix`):
   - `pname = "opencode"` → `"quillshield"`
   - `description` → update to smart contract auditing
   - `homepage` → update URL
   - `mainProgram = "opencode"` → `"quillshield"`
   - Install paths still reference `opencode` binary name

### Tier 3: Internal (Non-Breaking, Low Priority)

1. **Environment variables** — `OPENCODE_*` (50+ references across 25 files)
   - Decision: Keep as-is OR rename to `QUILLSHIELD_*` with backward compatibility
   - Recommendation: Keep as-is for now, rename later with env var aliasing
   - If renaming: `OPENCODE_CLIENT`, `OPENCODE_CONFIG`, `OPENCODE_SERVER_PASSWORD`, etc.

2. **Global type declarations** (`packages/quillshield/src/installation/index.ts`):
   - `OPENCODE_VERSION`, `OPENCODE_CHANNEL` — these are compile-time defines, renaming requires build script changes

3. **Installation method detection** (`installation/index.ts`):
   - References to `opencode-ai` (npm package name), `opencode` (brew/choco/scoop)
   - These need updating when you actually publish to a registry

4. **GitHub/repository URLs** — `anomalyco/opencode` referenced in changelog, installation, etc.

5. **Docker image references** — `ghcr.io/anomalyco/opencode`

## Recommended Approach

**Do now** (before first demo): Tier 1 (blocking) + Tier 2 desktop branding
**Do before alpha release**: Tier 2 remainder + clean up old prompt files
**Do before public release**: Tier 3 (env vars, installation, Docker, registry publishing)

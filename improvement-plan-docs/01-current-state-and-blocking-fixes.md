# 01 — Current State & Blocking Fixes

## What Was Done

The OpenCode monorepo has been forked into QuillShield. Here's what's been completed:

### Removed Packages
- `packages/console`, `packages/web`, `packages/slack`, `packages/enterprise`
- `packages/extensions`, `packages/containers`, `packages/identity`, `packages/function`
- `packages/storybook`, `packages/docs`
- `sst.config.ts` (SST infra config)

### Rebranded
- `packages/opencode/` → `packages/quillshield/`
- Root package.json: name → `quillshield`
- quillshield/package.json: name → `quillshield`, binary → `quillshield`
- `@opencode-ai/*` → `@quillshield/*` in packages/quillshield/src/, root, and all package.json files
- `global/index.ts`: app name → `"quillshield"`
- Config file names: `opencode.json` → `quillshield.json`
- Directory names: `.opencode/` → `.quillshield/`
- System prompt router updated to use audit prompt
- MCP client name → `"quillshield"`

### New Audit Infrastructure
- 6 agent definitions (audit, recon, scope, trace, exploit, report)
- 6 system prompts (audit.txt, recon.txt, scope.txt, trace.txt, exploit.txt, report.txt)
- 6 custom tools (scope-tracker, finding, contract-info, call-graph, storage-layout, audit-bash)
- 6 language parsers (Solidity, Vyper, Anchor, CosmWasm, Move, Cairo)
- Audit pipeline engine (src/audit/pipeline.ts)

### Verification
- `bun install` succeeds (1061 packages)

---

## BLOCKING FIXES (Must Do Before Any Build/Run Works)

### Fix 1: packages/ui still imports @opencode-ai/*

**Impact**: 80+ files in `packages/ui/src/` still use `@opencode-ai/sdk`, `@opencode-ai/util`, `@opencode-ai/ui`. This breaks the entire web UI, desktop app, and any component that touches the UI layer.

**Fix**:
```bash
find packages/ui/src -name "*.ts" -o -name "*.tsx" | xargs sed -i '' 's/@opencode-ai\//@quillshield\//g'
```

### Fix 2: packages/desktop/vite.config.ts

**Impact**: Desktop app won't build.

**Fix**: Change line 5:
```typescript
// FROM:
import appPlugin from "@opencode-ai/app/vite"
// TO:
import appPlugin from "@quillshield/app/vite"
```

### Fix 3: packages/sdk/js still has @opencode-ai references

**Impact**: SDK example and publish script broken.

**Fix**:
```bash
find packages/sdk/js -name "*.ts" -not -path "*/node_modules/*" | xargs sed -i '' 's/@opencode-ai\//@quillshield\//g'
```

### Fix 4: Remaining @opencode-ai imports scattered

Run this to catch everything remaining:
```bash
grep -rn "@opencode-ai/" packages/ --include="*.ts" --include="*.tsx" \
  --exclude-dir=node_modules --exclude-dir=dist | grep -v ".d.ts"
```

---

## HIGH PRIORITY (User-Visible, Do Within Same Session)

### Fix 5: Desktop branding still says OpenCode

Files to update:
- `packages/desktop/src/index.tsx`: `opencode:deep-link` → `quillshield:deep-link`, `window.__OPENCODE__` → `window.__QUILLSHIELD__`
- `packages/desktop/src/menu.ts`: URLs still point to `opencode.ai`
- `packages/desktop/src-tauri/tauri.conf.json`: productName, identifier, mainBinaryName

### Fix 6: Old coding prompt files still exist

These unused files should be deleted from `packages/quillshield/src/session/prompt/`:
- `anthropic.txt`, `anthropic-20250930.txt`
- `beast.txt`
- `codex_header.txt`
- `copilot-gpt-5.txt`
- `gemini.txt`
- `qwen.txt`
- `trinity.txt`
- `plan.txt`, `plan-reminder-anthropic.txt`
- `build-switch.txt`

Keep: `audit.txt`, `recon.txt`, `scope.txt`, `trace.txt`, `exploit.txt`, `report.txt`, `max-steps.txt`

### Fix 7: infra/ directory references deleted packages

`infra/console.ts` and `infra/enterprise.ts` reference deleted packages. Either delete the entire `infra/` directory or gut these files.

---

## Estimated Time to Fix All Blocking Issues

~15 minutes of sed commands and targeted edits. The core quillshield package compiles and the LLM loop works. The UI layer (app/desktop) needs the import fixes to build.

# 03 — Feature Gaps & Missing Pieces (Revised Assessment)

_Last updated: 2026-03-04_

## Current State: The Agent Already Works for Interactive Auditing

Before listing gaps, the important context: **QuillShield is usable today for manual, interactive smart contract auditing.** You can start a session, switch between audit/recon/scope/trace/exploit/report agents, and use all 6 audit tools. The gaps below are about automation, persistence, and polish — not core functionality.

---

## What's Built — Verified Working

| Component | Lines | Verdict |
|-----------|-------|---------|
| Agent definitions (6 agents) | ~370 | Real. All 6 agents defined with correct permissions, registered, switchable. |
| System prompts (6 .txt files) | ~310 | Real. Substantive domain content, properly imported and wired into session system. |
| Scope Tracker tool | ~104 | Real. In-memory state, 5 actions (init/add/remove/list/status). Works within a session. |
| Finding tool | ~134 | Real. Full CRUD with ULID generation, severity levels, PoC tracking. In-memory. |
| Contract Info tool | ~100 | Real. Delegates to language parsers, returns structured metadata. |
| Call Graph tool | ~204 | Real. Builds call trees with depth limiting, recursion detection, reentrancy surface. Solidity-only. |
| Storage Layout tool | ~173 | Real. EVM slot calculation, packed variable handling, proxy collision detection. |
| Audit Bash tool | ~150 | Real. Framework auto-detection (Foundry/Hardhat/Anchor/Move), shortcut commands, permission gating. |
| Solidity parser | ~273 | Real. The best parser — functions, state vars, events, errors, inheritance, external calls, storage slots. |
| Vyper parser | ~168 | Real. Decorator-based visibility, raw_call patterns. Simpler than Solidity but functional. |
| Anchor parser | ~191 | Real. Program module detection, account structs, CPI call tracking. Heuristic-based. |
| CosmWasm parser | ~169 | Real. Entry points, message enum parsing, storage items. Basic but functional. |
| Move parser | ~199 | Real. Module/function/struct parsing. Missing ability constraint analysis. |
| Cairo parser | ~259 | Real. Contract/interface detection, dispatcher calls, syscall patterns. Basic L1-L2. |
| Tool registry | — | All 6 audit tools registered at lines 121-126 of registry.ts. |

**Total audit-specific code: ~2,800 lines of real, working implementations.**

### Pipeline Engine — Needs Honest Clarification

| Component | Lines | Verdict |
|-----------|-------|---------|
| Pipeline state machine | ~204 | **Overstated as "Complete" in previous version.** It's a state machine that manages Run objects in memory and generates prompt strings. It does NOT invoke sessions, create agents, or run anything. It's the "recipe book with no kitchen." |

The pipeline has: create/get/list runs, advance/skip phases, set outputs/notes, generate phase prompts, produce summaries, emit bus events. What it doesn't have: any code that actually executes a phase by creating a session and invoking an agent.

---

## What's Missing — Prioritized by Actual Impact

### Tier 1: Actually Hurts (blocks real usage)

| Gap | Why it matters | Effort |
|-----|---------------|--------|
| **DB persistence for findings** | Findings vanish on session close. You can't do a multi-session audit. This is the single biggest pain point. | ~100 lines (Drizzle schema + update finding.ts) |
| **DB persistence for scope** | Same issue — scope state lost on restart. Less painful than findings since re-scanning is fast, but still annoying. | ~80 lines (same pattern as findings) |

### Tier 2: Would Be Nice (improves workflow but not blocking)

| Gap | Why it matters | Effort |
|-----|---------------|--------|
| **Pipeline ↔ Session integration** | Lets you run `scope -> analyze -> trace -> exploit -> report` automatically instead of manually switching agents. Nice automation, but manual switching already works. | ~200-300 lines (needs to understand Session.chat() internals) |
| **`/audit` CLI command** | Entry point for the pipeline. Useless without Tier 2 pipeline integration. | ~100 lines (yargs command + pipeline invocation) |
| **Slither/Mythril integration** | Structured parsing of static analysis output to feed into the audit. Currently you can run these via audit-bash but output isn't parsed. | ~150 lines per tool |
| **Foundry forge test integration** | Same — structured result parsing from `forge test` output. | ~100 lines |

### Tier 3: Don't Build Yet (premature or unnecessary)

| Gap | Why it's premature |
|-----|-------------------|
| **DB persistence for pipeline runs** | Pipeline doesn't invoke sessions yet. Persisting its state before it works is pointless. |
| **`/audit` TUI checkpoint UI** | Depends on pipeline actually working. Build after pipeline integration. |
| **Finding deduplication** | The LLM won't duplicate findings if instructed properly. Solve with prompting, not code. |
| **Severity calibration** | LLM judgment is good enough. Automated scoring adds complexity for marginal value. |
| **Report export (MD to PDF)** | `pandoc` exists. One shell command. Not worth custom code. |
| **Web UI audit views** | Project is TUI/CLI only. Not needed. |

---

## Recommended Implementation Order

### Step 1: DB Persistence for Findings (the only truly critical gap)

**Schema** — create `packages/quillshield/src/audit/audit.sql.ts`:

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const auditFinding = sqliteTable("audit_finding", {
  id: text("id").primaryKey(),
  session_id: text("session_id").notNull(),
  severity: text("severity").notNull(),           // critical|high|medium|low|informational
  title: text("title").notNull(),
  description: text("description"),
  impact: text("impact"),
  contracts: text("contracts"),                    // JSON array
  status: text("status").notNull().default("draft"), // draft|confirmed|false-positive
  poc_status: text("poc_status").notNull().default("none"), // none|written|passing|failing
  recommendation: text("recommendation"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
})
```

**Steps:**
1. Create the schema file above
2. Register in `packages/quillshield/src/storage/schema.ts`
3. Run `cd packages/quillshield && bun drizzle-kit generate`
4. Update `finding.ts`: replace `Map<string, Finding[]>` with Drizzle queries
5. Test: add a finding, restart session, verify it persists

### Step 2: DB Persistence for Scope (small, same pattern)

Add `auditScope` table to the same schema file:

```typescript
export const auditScope = sqliteTable("audit_scope", {
  id: text("id").primaryKey(),
  session_id: text("session_id").notNull(),
  path: text("path").notNull(),
  name: text("name").notNull(),
  language: text("language").notNull(),
  status: text("status").notNull().default("pending"),
  findings_count: integer("findings_count").notNull().default(0),
  created_at: text("created_at").notNull(),
})
```

Update `scope-tracker.ts` the same way as finding.ts.

### Step 3: Skip Everything Else For Now

The pipeline automation, CLI command, parser improvements, and tool integrations are all secondary. Do real audits first with the manual workflow. Fix what actually breaks. The architecture supports adding all of this later without refactoring.

---

## What the Previous Doc Got Wrong

1. **Pipeline engine was listed as "Complete"** — It's a state machine with no execution capability. Should have been listed as "30% complete" since it only manages state and generates prompts.

2. **DB persistence for pipeline runs was listed as "HIGH" priority** — It's actually LOW. The pipeline doesn't run anything yet, so persisting its state is premature.

3. **Several items were listed as HIGH/MEDIUM that are actually unnecessary:**
   - Finding deduplication: solve with prompting
   - Severity calibration: LLM handles this fine
   - Web UI audit views: project is TUI-only

4. **The doc missed the bigger picture:** The agent is already functional for interactive auditing. The gaps are about automation and persistence, not core capability. The framing of "Critical Missing" was too alarmist for things that are really "nice to have."

---

## References

- Parser details: see `04-language-parser-improvements.md`
- Tool enhancement details: see `05-tool-improvements-and-new-tools.md`
- Pipeline integration deep-dive: see `06-pipeline-and-session-integration.md`

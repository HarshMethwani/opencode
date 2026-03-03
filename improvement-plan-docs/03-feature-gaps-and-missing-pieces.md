# 03 — Feature Gaps & Missing Pieces

## What's Built vs What's Skeleton

### Fully Built (working implementations)

| Component | Status | Notes |
|-----------|--------|-------|
| Agent definitions | Complete | audit, recon, scope, trace, exploit, report + infrastructure agents |
| System prompts | Complete | All 6 audit prompts written with domain expertise |
| Scope Tracker tool | Complete | In-memory state per session, add/remove/list/status |
| Finding tool | Complete | Full CRUD with severity, PoC tracking, session scoped |
| Contract Info tool | Complete | Delegates to language parsers, structured output |
| Storage Layout tool | Complete | EVM slot analysis, proxy collision detection |
| Audit Bash tool | Complete | Framework auto-detection, shortcut commands |
| Solidity parser | Complete | Functions, state vars, events, errors, inheritance, external calls, storage |
| Pipeline engine | Complete | 5-phase state machine with context passing between phases |

### Partially Built (needs more work)

| Component | Status | What's Missing |
|-----------|--------|----------------|
| Call Graph tool | 80% | Only scans .sol files; needs multi-language support |
| Vyper parser | 70% | extractCalls is basic; needs better interface call detection |
| Anchor parser | 70% | CPI call detection is heuristic; needs better account validation analysis |
| CosmWasm parser | 60% | State item detection is basic; needs better message routing analysis |
| Move parser | 60% | Global storage access tracked but no ability constraint analysis |
| Cairo parser | 60% | Dispatcher detection works; needs better L1-L2 messaging analysis |

### Not Built (planned but empty)

| Component | Priority | Description |
|-----------|----------|-------------|
| Database persistence for findings | HIGH | Findings are in-memory only — lost on restart. Need Drizzle schema + migration. |
| Database persistence for audit scope | HIGH | Same — scope state is in-memory only. |
| Database persistence for pipeline runs | HIGH | Pipeline runs are in-memory only. |
| `/audit` CLI command | HIGH | The pipeline.ts engine exists but there's no CLI command to invoke it. |
| `/audit` TUI integration | MEDIUM | No checkpoint UI in the TUI. |
| Pipeline ↔ Session integration | HIGH | Pipeline generates prompts but doesn't actually invoke sessions/agents. |
| Report export (MD → PDF) | LOW | Report agent generates markdown; no PDF conversion. |
| Finding deduplication | MEDIUM | No logic to detect duplicate findings across sessions. |
| Severity calibration | LOW | No automated severity scoring — relies on LLM judgment. |
| Integration with Slither/Mythril | MEDIUM | No integration with external static analysis tools. |
| Integration with Foundry forge test | MEDIUM | audit-bash can run commands but doesn't parse/structure results. |
| Web UI audit views | LOW | No custom views for findings list, scope overview, pipeline progress. |

---

## Critical Missing: Database Tables for Audit State

The plan specified 3 new tables. None have been created yet.

### What's needed:

```sql
-- Table: audit_run
CREATE TABLE audit_run (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  directory TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'scope',
  status TEXT NOT NULL DEFAULT 'pending',
  phase_outputs TEXT, -- JSON
  user_notes TEXT, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Table: audit_finding
CREATE TABLE audit_finding (
  id TEXT PRIMARY KEY,
  audit_run_id TEXT REFERENCES audit_run(id),
  session_id TEXT NOT NULL REFERENCES session(id),
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  impact TEXT,
  contracts TEXT, -- JSON array
  status TEXT NOT NULL DEFAULT 'draft',
  poc_status TEXT NOT NULL DEFAULT 'none',
  recommendation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Table: audit_scope
CREATE TABLE audit_scope (
  id TEXT PRIMARY KEY,
  audit_run_id TEXT REFERENCES audit_run(id),
  session_id TEXT NOT NULL REFERENCES session(id),
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  findings_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Steps to add:
1. Create Drizzle schema file: `packages/quillshield/src/audit/audit.sql.ts`
2. Register in `packages/quillshield/src/storage/schema.ts`
3. Run `cd packages/quillshield && bun drizzle-kit generate` to create migration
4. Update scope-tracker.ts and finding.ts tools to use DB instead of in-memory maps

---

## Critical Missing: Pipeline ↔ Session Integration

The pipeline engine (`audit/pipeline.ts`) generates phase prompts but has no code to actually:
1. Create a session for each phase
2. Invoke the correct subagent
3. Collect the agent's output
4. Store it as phase output
5. Emit checkpoint events for the TUI

This is the **biggest functional gap**. Without this, the pipeline is a state machine that never runs.

### What's needed:
- A function like `runPhase(run: Run)` that:
  - Creates a session via the existing session system
  - Sets the agent to the appropriate subagent for the phase
  - Sends the phase prompt as a user message
  - Waits for the agent to complete (or hit step limit)
  - Extracts the agent's output
  - Stores it via `setPhaseOutput()`
  - Emits `CheckpointReached` event
  - Pauses for user review

### Where to hook in:
- The session system is in `packages/quillshield/src/session/index.ts`
- Look at how the existing `Session.chat()` or `Session.prompt()` works
- The pipeline should use the same mechanism

---

## Critical Missing: /audit CLI Command

Need to add to `packages/quillshield/src/cli/cmd/`:

```typescript
// audit-pipeline.ts
// CLI command: `quillshield audit [directory]`
// - Creates a pipeline run
// - Starts scope phase
// - Shows progress
// - Pauses at checkpoints
```

Also need to register it as a yargs command in the CLI bootstrap.

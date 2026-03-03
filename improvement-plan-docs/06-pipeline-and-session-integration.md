# 06 — Pipeline & Session Integration

## The Big Gap

The audit pipeline engine (`src/audit/pipeline.ts`) is a state machine that:
- Tracks phases (scope → analyze → trace → exploit → report)
- Generates phase-specific prompts with context from previous phases
- Manages user notes between phases
- Emits events for UI hooks

But it **does NOT actually run anything**. There's no code that:
1. Creates a session for a phase
2. Sets the correct agent
3. Sends the prompt
4. Waits for completion
5. Collects output
6. Advances to the next phase

This is the single most important piece to build next.

---

## Implementation Plan

### Step 1: Pipeline Runner

Create `packages/quillshield/src/audit/runner.ts`:

```typescript
import { AuditPipeline } from "./pipeline"
import { Session } from "../session"

export namespace AuditRunner {
  // Map phase to agent name
  const PHASE_AGENT: Record<AuditPipeline.Phase, string> = {
    scope: "scope",
    analyze: "audit",
    trace: "trace",
    exploit: "exploit",
    report: "report",
  }

  export async function runPhase(runID: string): Promise<string> {
    const run = AuditPipeline.get(runID)
    if (!run) throw new Error(`Run not found: ${runID}`)

    AuditPipeline.setStatus(runID, "running")

    // Get the prompt for this phase
    const prompt = AuditPipeline.phasePrompt(run)
    const agent = PHASE_AGENT[run.phase]

    // Create or reuse session
    const session = await Session.create({
      agent,
      // Use the run's session or create new
    })

    // Send the phase prompt and wait for completion
    const result = await Session.chat(session.id, {
      parts: [{ type: "text", text: prompt }],
      agent,
    })

    // Extract the text output from the assistant's response
    const output = extractTextOutput(result)

    // Store the phase output
    AuditPipeline.setPhaseOutput(runID, run.phase, output)
    AuditPipeline.setStatus(runID, "paused")

    // Emit checkpoint event
    await AuditPipeline.Event.CheckpointReached.publish({
      runID,
      phase: run.phase,
      summary: summarizePhaseOutput(run.phase, output),
    })

    return output
  }

  export async function runAll(runID: string, onCheckpoint: (phase: string, summary: string) => Promise<"continue" | "stop">) {
    const run = AuditPipeline.get(runID)
    if (!run) throw new Error(`Run not found: ${runID}`)

    while (run.status !== "completed") {
      const output = await runPhase(runID)
      const summary = summarizePhaseOutput(run.phase, output)

      const action = await onCheckpoint(run.phase, summary)
      if (action === "stop") break

      const advanced = AuditPipeline.advance(runID)
      if (!advanced || advanced.status === "completed") break
    }
  }
}
```

### Step 2: Understand the Session API

Before implementing, need to study:
- `packages/quillshield/src/session/index.ts` — How sessions are created and managed
- `packages/quillshield/src/session/llm.ts` — How LLM calls are made
- `packages/quillshield/src/server/server.ts` — The Hono API routes for session/prompt

The session system likely has:
- `Session.create(opts)` — creates a new session
- Some way to send a message and get a streaming response
- Agent selection per session or per message

### Step 3: CLI Command

Create `packages/quillshield/src/cli/cmd/audit.ts`:

```typescript
import { command } from "yargs"

export const auditCommand = {
  command: "audit [directory]",
  describe: "Run an autonomous security audit pipeline",
  builder: (yargs) => yargs
    .positional("directory", { type: "string", default: "." })
    .option("phase", { type: "string", describe: "Start from a specific phase" })
    .option("auto", { type: "boolean", describe: "Run all phases without pausing", default: false }),
  handler: async (args) => {
    // 1. Create pipeline run
    // 2. If --auto, run all phases
    // 3. Otherwise, run phase by phase with interactive checkpoints
    // 4. Display progress and results
  }
}
```

Register it in the CLI bootstrap (wherever yargs commands are registered).

### Step 4: TUI Integration

The TUI needs a way to:
1. Show the current pipeline phase and progress
2. Display phase output summaries at checkpoints
3. Let the user add notes before continuing
4. Let the user skip phases or re-run

This should integrate with the existing TUI dialog system. Look at how the existing dialogs work in `packages/quillshield/src/cli/cmd/tui/component/dialog-*.tsx`.

### Step 5: Server API Endpoint

Add to the Hono server (`packages/quillshield/src/server/server.ts`):

```
POST /audit/start       — Create and start a pipeline run
GET  /audit/:id         — Get pipeline run status
POST /audit/:id/advance — Advance to next phase
POST /audit/:id/notes   — Add user notes for current phase
POST /audit/:id/skip    — Skip to a specific phase
GET  /audit/:id/report  — Get the final report
```

---

## Integration Architecture

```
User types "/audit" or runs "quillshield audit ."
        │
        ▼
   CLI/TUI creates AuditPipeline.Run
        │
        ▼
   AuditRunner.runPhase(runID)
        │
        ├── Gets phase prompt from pipeline
        ├── Creates/reuses Session
        ├── Sets agent to phase-specific agent
        ├── Sends prompt via Session.chat()
        ├── Agent runs autonomously (reads files, uses tools, reasons)
        ├── Agent completes or hits step limit
        ├── Collects output text
        └── Stores output, emits checkpoint event
        │
        ▼
   TUI shows checkpoint
   User reviews, adds notes, clicks "Continue"
        │
        ▼
   AuditPipeline.advance(runID) → next phase
        │
        ▼
   AuditRunner.runPhase(runID) — with previous outputs as context
        │
        ... (repeat until report phase completes)
        │
        ▼
   Final report generated and saved
```

---

## Key Decision: Session Per Phase vs Single Session

**Option A: One session per phase** (Recommended)
- Clean context for each phase
- Each phase starts fresh with only the relevant context from previous phases
- Prevents context window overflow
- Agent can be different per phase

**Option B: Single session for entire audit**
- Full context throughout
- Risk of context overflow on large protocols
- Harder to manage agent switching

Recommendation: Option A with phase outputs passed as structured context.

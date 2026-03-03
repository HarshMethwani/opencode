import z from "zod"
import { ulid } from "ulid"
import { BusEvent } from "@/bus/bus-event"

export namespace AuditPipeline {
  export const Phase = z.enum(["scope", "analyze", "trace", "exploit", "report"])
  export type Phase = z.infer<typeof Phase>

  export const Status = z.enum(["pending", "running", "paused", "completed", "failed"])
  export type Status = z.infer<typeof Status>

  export const Run = z.object({
    id: z.string(),
    sessionID: z.string(),
    directory: z.string(),
    phase: Phase,
    status: Status,
    createdAt: z.string(),
    updatedAt: z.string(),
    phaseOutputs: z.record(Phase, z.string()),
    userNotes: z.record(Phase, z.string()),
  })
  export type Run = z.infer<typeof Run>

  export const Event = {
    PhaseStarted: BusEvent.define(
      "audit.phase.started",
      z.object({
        runID: z.string(),
        phase: Phase,
      }),
    ),
    PhaseCompleted: BusEvent.define(
      "audit.phase.completed",
      z.object({
        runID: z.string(),
        phase: Phase,
        output: z.string(),
      }),
    ),
    PhaseFailed: BusEvent.define(
      "audit.phase.failed",
      z.object({
        runID: z.string(),
        phase: Phase,
        error: z.string(),
      }),
    ),
    CheckpointReached: BusEvent.define(
      "audit.checkpoint",
      z.object({
        runID: z.string(),
        phase: Phase,
        summary: z.string(),
      }),
    ),
    Completed: BusEvent.define(
      "audit.completed",
      z.object({
        runID: z.string(),
      }),
    ),
  }

  const runs = new Map<string, Run>()

  const PHASE_ORDER: Phase[] = ["scope", "analyze", "trace", "exploit", "report"]

  export function create(sessionID: string, directory: string): Run {
    const run: Run = {
      id: ulid(),
      sessionID,
      directory,
      phase: "scope",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phaseOutputs: {},
      userNotes: {},
    }
    runs.set(run.id, run)
    return run
  }

  export function get(runID: string): Run | undefined {
    return runs.get(runID)
  }

  export function list(sessionID?: string): Run[] {
    const all = Array.from(runs.values())
    return sessionID ? all.filter((r) => r.sessionID === sessionID) : all
  }

  export function nextPhase(run: Run): Phase | undefined {
    const idx = PHASE_ORDER.indexOf(run.phase)
    if (idx < 0 || idx >= PHASE_ORDER.length - 1) return undefined
    return PHASE_ORDER[idx + 1]
  }

  export function advance(runID: string): Run | undefined {
    const run = runs.get(runID)
    if (!run) return undefined

    const next = nextPhase(run)
    if (!next) {
      run.status = "completed"
      run.updatedAt = new Date().toISOString()
      return run
    }

    run.phase = next
    run.status = "paused"
    run.updatedAt = new Date().toISOString()
    return run
  }

  export function setPhaseOutput(runID: string, phase: Phase, output: string): void {
    const run = runs.get(runID)
    if (!run) return
    run.phaseOutputs[phase] = output
    run.updatedAt = new Date().toISOString()
  }

  export function setUserNotes(runID: string, phase: Phase, notes: string): void {
    const run = runs.get(runID)
    if (!run) return
    run.userNotes[phase] = notes
    run.updatedAt = new Date().toISOString()
  }

  export function setStatus(runID: string, status: Status): void {
    const run = runs.get(runID)
    if (!run) return
    run.status = status
    run.updatedAt = new Date().toISOString()
  }

  export function skipToPhase(runID: string, phase: Phase): Run | undefined {
    const run = runs.get(runID)
    if (!run) return undefined
    run.phase = phase
    run.status = "paused"
    run.updatedAt = new Date().toISOString()
    return run
  }

  export function phasePrompt(run: Run): string {
    const phase = run.phase
    const previousOutputs = PHASE_ORDER.filter((p) => run.phaseOutputs[p])
      .map((p) => `## ${p.toUpperCase()} Phase Output\n${run.phaseOutputs[p]}`)
      .join("\n\n")

    const userNotes = Object.entries(run.userNotes)
      .map(([p, n]) => `## User Notes (${p})\n${n}`)
      .join("\n\n")

    const context = [
      `Audit Pipeline Run: ${run.id}`,
      `Current Phase: ${phase}`,
      `Target Directory: ${run.directory}`,
      previousOutputs && `\n# Previous Phase Outputs\n${previousOutputs}`,
      userNotes && `\n# User Notes\n${userNotes}`,
    ]
      .filter(Boolean)
      .join("\n")

    switch (phase) {
      case "scope":
        return `${context}\n\nPerform the SCOPE phase: Enumerate all contracts in the project at ${run.directory}. Map the protocol architecture, identify all contracts, their relationships, trust boundaries, and attack surface. Use the scope and contract-info tools. Output a comprehensive protocol model.`

      case "analyze":
        return `${context}\n\nPerform the ANALYZE phase: Review each contract in scope deeply. Identify potential vulnerabilities, suspicious patterns, and attack hypotheses. For each hypothesis, describe: what the vulnerability would be, which contracts/functions are involved, and why you think it might be exploitable. Output a prioritized list of hypotheses to investigate.`

      case "trace":
        return `${context}\n\nPerform the TRACE phase: For each hypothesis from the analyze phase, trace the exact execution path. Follow every condition, state change, and external call. Determine if each hypothesis is CONFIRMED, FALSE POSITIVE, or NEEDS INVESTIGATION. Use the call-graph tool for cross-contract tracing. Record confirmed findings using the finding tool.`

      case "exploit":
        return `${context}\n\nPerform the EXPLOIT phase: For each confirmed finding, write a proof-of-concept exploit. Use Foundry test format. Deploy contracts, set state, execute the attack, and assert the impact. Compile and run each PoC. Update finding PoC status using the finding tool.`

      case "report":
        return `${context}\n\nPerform the REPORT phase: Generate the complete audit report. Include: Executive Summary, Scope, all Findings (with severity, description, impact, PoC references, recommendations), and Methodology. Use the finding tool to retrieve all findings. Output in markdown format.`
    }
  }

  export function phaseSummary(run: Run): string {
    const lines = [
      `Audit Run: ${run.id}`,
      `Status: ${run.status}`,
      `Current Phase: ${run.phase}`,
      `Directory: ${run.directory}`,
      "",
      "Phase Progress:",
    ]

    for (const phase of PHASE_ORDER) {
      const hasOutput = !!run.phaseOutputs[phase]
      const isCurrent = phase === run.phase
      const icon = hasOutput ? "[done]" : isCurrent ? "[>>]" : "[  ]"
      lines.push(`  ${icon} ${phase}`)
    }

    return lines.join("\n")
  }
}

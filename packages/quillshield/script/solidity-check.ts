#!/usr/bin/env bun

import path from "path"
import { tmpdir } from "os"
import type { Tool } from "../src/tool/tool"

const cwd = process.cwd()

type Result = {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: unknown[]
}

type Loaded = {
  init(): Promise<{
    execute(args: Record<string, unknown>, ctx: Tool.Context): Promise<Result>
  }>
}

process.chdir(path.resolve(import.meta.dir, ".."))
process.env.XDG_DATA_HOME ||= path.join(tmpdir(), "quillshield-tool-check")

const yargs = (await import("yargs")).default
const { hideBin } = await import("yargs/helpers")

const all = {
  "contract-info": { function: false },
  "inheritance-resolver": { function: false },
  "storage-layout": { function: false },
  "auth-surface": { function: true },
  "state-flow": { function: true },
  "value-flow": { function: true },
  "upgrade-check": { function: false },
} as const

async function load(id: keyof typeof all): Promise<Loaded> {
  if (id === "contract-info") return (await import("../src/tool/contract-info"))["ContractInfoTool"] as unknown as Loaded
  if (id === "inheritance-resolver")
    return (await import("../src/tool/inheritance-resolver"))["InheritanceResolverTool"] as unknown as Loaded
  if (id === "storage-layout") return (await import("../src/tool/storage-layout"))["StorageLayoutTool"] as unknown as Loaded
  if (id === "auth-surface") return (await import("../src/tool/auth-surface"))["AuthSurfaceTool"] as unknown as Loaded
  if (id === "state-flow") return (await import("../src/tool/state-flow"))["StateFlowTool"] as unknown as Loaded
  if (id === "value-flow") return (await import("../src/tool/value-flow"))["ValueFlowTool"] as unknown as Loaded
  return (await import("../src/tool/upgrade-check"))["UpgradeCheckTool"] as unknown as Loaded
}

const defaults = Object.keys(all)

const args = await yargs(hideBin(process.argv))
  .scriptName("solidity-check")
  .usage("$0 --project <dir> --path <file> [options]")
  .option("project", {
    type: "string",
    describe: "Path to the Solidity project root",
  })
  .option("path", {
    type: "string",
    describe: "Path to the Solidity file, relative to the project when possible",
  })
  .option("contract", {
    type: "string",
    describe: "Specific contract name inside the file",
  })
  .option("function", {
    type: "string",
    array: true,
    describe: "Optional function name filter. Repeat for multiple functions.",
  })
  .option("tool", {
    type: "string",
    array: true,
    choices: defaults,
    describe: "Tool to run. Repeat for multiple tools.",
  })
  .option("output", {
    type: "string",
    describe: "Optional path to save the markdown report",
  })
  .option("list-tools", {
    type: "boolean",
    default: false,
    describe: "List supported tools and exit",
  })
  .strict()
  .parse()

if (args["list-tools"]) {
  console.log(defaults.join("\n"))
  process.exit(0)
}

if (!args.project || !args.path) {
  console.error("Both --project and --path are required unless --list-tools is used.")
  process.exit(1)
}

const project = path.isAbsolute(String(args.project)) ? String(args.project) : path.resolve(cwd, String(args.project))
const file = path.isAbsolute(String(args.path)) ? String(args.path) : path.resolve(project, String(args.path))

if (!(await Bun.file(file).exists())) {
  console.error(`File not found: ${file}`)
  process.exit(1)
}

const selected = (args.tool?.length ? args.tool : defaults) as Array<keyof typeof all>
const funcs = (args.function ?? []).map(String)
const { Instance } = await import("../src/project/instance")
const ctx: Tool.Context = {
  sessionID: "solidity-check",
  messageID: "solidity-check",
  agent: "audit",
  abort: new AbortController().signal,
  messages: [],
  metadata(_input) {},
  ask: async (_input) => {},
}

const report = await Instance.provide({
  directory: project,
  fn: async () => {
    const loaded = new Map<keyof typeof all, Awaited<ReturnType<typeof load>>>()
    for (const id of selected) {
      loaded.set(id, await load(id))
    }

    const jobs = [] as Array<
      Promise<{
        id: keyof typeof all
        fn?: string
        result: Result
      }>
    >

    selected.forEach((id) => {
      const item = all[id]
      if (item.function && funcs.length) {
        funcs.forEach((fn) => {
          jobs.push((async () => {
            const tool = loaded.get(id)
            if (!tool) throw new Error(`Tool not loaded: ${id}`)
            const run = await tool.init()
            return {
              id,
              fn,
              result: await run.execute(
                {
                  path: String(args.path),
                  contract: args.contract,
                  function: fn,
                },
                ctx,
              ),
            }
          })())
        })
        return
      }

      jobs.push((async () => {
        const tool = loaded.get(id)
        if (!tool) throw new Error(`Tool not loaded: ${id}`)
        const run = await tool.init()
        return {
          id,
          result: await run.execute(
            {
              path: String(args.path),
              contract: args.contract,
            },
            ctx,
          ),
        }
      })())
    })

    const results = await Promise.all(jobs)
    const lines = [
      "# Solidity Tool Check",
      "",
      `- Project: ${project}`,
      `- File: ${String(args.path)}`,
      `- Contract: ${args.contract ?? "auto"}`,
      `- Tools: ${selected.join(", ")}`,
      `- Functions: ${funcs.length ? funcs.join(", ") : "all/default"}`,
    ]

    results.forEach((item) => {
      lines.push("", `## ${item.id}${item.fn ? ` (${item.fn})` : ""}`, "", `Title: ${item.result.title}`, "", item.result.output.trim())
      if (Object.keys(item.result.metadata).length) {
        lines.push("", "Metadata:", "```json", JSON.stringify(item.result.metadata, null, 2), "```")
      }
    })

    return lines.join("\n") + "\n"
  },
})

if (args.output) {
  const output = path.isAbsolute(String(args.output)) ? String(args.output) : path.resolve(cwd, String(args.output))
  await Bun.write(output, report)
  console.log(`Saved report to ${output}`)
}

console.log(report)

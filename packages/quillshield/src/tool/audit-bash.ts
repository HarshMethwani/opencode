import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { $ } from "bun"
import path from "path"
import fs from "fs/promises"

type Framework = "foundry" | "hardhat" | "anchor" | "move" | "unknown"

async function detectFramework(directory: string): Promise<Framework> {
  const checks = [
    { file: "foundry.toml", framework: "foundry" as const },
    { file: "hardhat.config.ts", framework: "hardhat" as const },
    { file: "hardhat.config.js", framework: "hardhat" as const },
    { file: "Anchor.toml", framework: "anchor" as const },
    { file: "Move.toml", framework: "move" as const },
  ]

  for (const check of checks) {
    const exists = await fs.access(path.join(directory, check.file)).then(() => true).catch(() => false)
    if (exists) return check.framework
  }

  return "unknown"
}

export const AuditBashTool = Tool.define("audit-bash", {
  description:
    "Run compilation, test, and analysis commands for smart contract projects. Auto-detects the framework (Foundry, Hardhat, Anchor, Move). Provides shortcuts: 'compile', 'test', 'fuzz' that map to the correct framework commands.",
  parameters: z.object({
    command: z
      .string()
      .describe(
        "Command to run. Use shortcuts 'compile', 'test', 'fuzz' for framework-aware commands, or provide a full shell command.",
      ),
    framework: z
      .enum(["foundry", "hardhat", "anchor", "move"])
      .optional()
      .describe("Override framework auto-detection"),
    cwd: z.string().optional().describe("Working directory (default: project root)"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 120000)"),
  }),
  async execute(args, ctx) {
    const cwd = args.cwd
      ? path.isAbsolute(args.cwd)
        ? args.cwd
        : path.resolve(Instance.directory, args.cwd)
      : Instance.directory

    const framework = args.framework ?? (await detectFramework(cwd))
    const timeout = args.timeout ?? 120_000

    let command = args.command

    // Expand shortcuts
    if (command === "compile" || command === "build") {
      switch (framework) {
        case "foundry":
          command = "forge build"
          break
        case "hardhat":
          command = "npx hardhat compile"
          break
        case "anchor":
          command = "anchor build"
          break
        case "move":
          command = "aptos move compile"
          break
        default:
          return { title: "Error", output: `Cannot compile: no framework detected in ${cwd}`, metadata: { exitCode: 1 } }
      }
    } else if (command === "test") {
      switch (framework) {
        case "foundry":
          command = "forge test -vvv"
          break
        case "hardhat":
          command = "npx hardhat test"
          break
        case "anchor":
          command = "anchor test"
          break
        case "move":
          command = "aptos move test"
          break
        default:
          return { title: "Error", output: `Cannot test: no framework detected in ${cwd}`, metadata: { exitCode: 1 } }
      }
    } else if (command === "fuzz") {
      switch (framework) {
        case "foundry":
          command = "forge test --fuzz-runs 1000 -vvv"
          break
        default:
          return {
            title: "Error",
            output: `Fuzzing only supported for Foundry. Detected framework: ${framework}`,
            metadata: { exitCode: 1 },
          }
      }
    }

    await ctx.ask({
      permission: "bash",
      patterns: [command],
      metadata: { command, framework, cwd },
      always: [],
    })

    const result = await $`bash -c ${command}`
      .cwd(cwd)
      .nothrow()
      .quiet()

    const stdout = result.stdout.toString("utf-8")
    const stderr = result.stderr.toString("utf-8")
    const exitCode = result.exitCode

    const lines: string[] = [
      `Framework: ${framework}`,
      `Command: ${command}`,
      `Exit code: ${exitCode}`,
      "",
    ]

    if (stdout) lines.push("--- stdout ---", stdout)
    if (stderr) lines.push("--- stderr ---", stderr)

    // Highlight errors for common patterns
    if (exitCode !== 0) {
      lines.push("", "--- Analysis ---")
      if (stderr.includes("Error") || stdout.includes("Error")) {
        lines.push("Compilation or test errors detected. Review the output above.")
      }
      if (stderr.includes("out of gas") || stdout.includes("out of gas")) {
        lines.push("Out of gas error — consider increasing gas limit or optimizing.")
      }
      if (stderr.includes("revert") || stdout.includes("revert")) {
        lines.push("Transaction reverted — check require/revert conditions.")
      }
    }

    return {
      title: exitCode === 0 ? `OK: ${command}` : `FAIL(${exitCode}): ${command}`,
      output: lines.join("\n"),
      metadata: { exitCode },
    }
  },
})

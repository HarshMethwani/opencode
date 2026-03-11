import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { analyzeProject, findContract, findContractsByPath } from "../solidity"

function sensitive(fn: { name: string; writes: string[] }) {
  if (/(upgrade|implementation|beacon|admin|owner|controller|authority|govern|role|whitelist|blacklist|pause)/i.test(fn.name)) {
    return true
  }
  return fn.writes.some((item) => /(implementation|beacon|admin|owner|controller|authority|role|whitelist|blacklist|pause|unlock)/i.test(item))
}

function initLike(name: string) {
  return /(?:^|_)(?:re)?initialize/i.test(name) || /__.*_init(?:_unchained)?$/i.test(name)
}

export const UpgradeCheckTool = Tool.define("upgrade-check", {
  description:
    "Check Solidity upgrade and proxy risk from compiler-backed facts. Detects proxy patterns, initializer safety, upgrade entrypoints, storage gaps, and admin/auth gaps around upgrades.",
  parameters: z.object({
    path: z.string().describe("Path to the Solidity contract file"),
    contract: z.string().optional().describe("Specific contract name in the file"),
  }),
  async execute(args) {
    const filepath = path.isAbsolute(args.path) ? args.path : path.resolve(Instance.directory, args.path)
    const ir = await analyzeProject(path.dirname(filepath))
    const target =
      findContract(ir, { file: filepath, name: args.contract }) ??
      findContractsByPath(ir, filepath)[0]

    if (!target) {
      return {
        title: "Not found",
        output: `No Solidity contracts from compiler output matched: ${args.path}`,
        metadata: {},
      }
    }

    const lines = [`Upgrade Check: ${target.name}`, ""]
    const warnings = [] as string[]
    const constructors = target.functions.filter((fn) => fn.kind === "constructor")
    const init = target.functions.filter((fn) => initLike(fn.name))
    const entry = target.functions.filter((fn) => /upgradeTo|upgradeToAndCall|setImplementation|setBeacon/i.test(fn.name))
    const control = target.functions.filter((fn) => (fn.visibility === "public" || fn.visibility === "external") && sensitive(fn))
    const localGap = target.storage.filter((slot) => /__gap|gap/i.test(slot.label))
    const selfLocked = constructors.some((fn) => fn.calls.some((call) => call.method === "_disableInitializers"))
    const externalInit = init.filter((fn) => fn.visibility === "public" || fn.visibility === "external")
    const internalInit = init.filter((fn) => fn.visibility === "internal" || fn.visibility === "private")

    if (!target.proxies.length && !target.initializers.length) {
      lines.push("No obvious upgrade or proxy signals detected.")
      return {
        title: `Upgrade check: ${target.name}`,
        output: lines.join("\n"),
        metadata: {},
      }
    }

    if (target.proxies.length) {
      lines.push("Proxy Signals:")
      target.proxies.forEach((item) => lines.push(`  - ${item.kind}: ${item.note}`))
    }

    lines.push("", "Initializer Surface:")
    if (!init.length) {
      lines.push("  none detected")
    }
    init.forEach((fn) => {
      const auth = [...new Set(fn.auth.map((item) => item.label))]
      const mods = fn.modifiers.length ? ` modifiers=${fn.modifiers.join(", ")}` : ""
      const labels = auth.length ? ` auth=${auth.join(", ")}` : " auth=NONE"
      lines.push(`  - ${fn.visibility} ${fn.signature}${mods}${labels}`)
      const checks = [...fn.modifiers, ...auth]
      if (!checks.some((item) => /initializer|onlyInitializing/i.test(item))) {
        warnings.push(`${fn.signature} is initializer-like without initializer or onlyInitializing signal`)
      }
    })

    lines.push("", "Implementation Locking:")
    lines.push(`  constructor _disableInitializers: ${selfLocked ? "yes" : "no"}`)
    if (!selfLocked && target.proxies.length) {
      warnings.push("upgradeable contract does not appear to self-lock the implementation via constructor/_disableInitializers")
    }
    if (internalInit.length && !externalInit.length) {
      warnings.push("initializer routines are internal-only — verify a public initializer exists in the deployment entrypoint")
    }

    if (entry.length) {
      lines.push("", "Upgrade Entry Points:")
      entry.forEach((fn) => {
        const auth = [...new Set(fn.auth.map((item) => item.label))]
        const mods = fn.modifiers.length ? ` modifiers=${fn.modifiers.join(", ")}` : ""
        lines.push(`  - ${fn.signature}${mods} auth=${auth.length ? auth.join(", ") : "NONE"}`)
        if (!auth.length && !fn.modifiers.some((item) => /only/i.test(item))) {
          warnings.push(`${fn.signature} looks like an upgrade entrypoint without an auth signal`)
        }
      })
    }

    if (control.length) {
      lines.push("", "Control Surface:")
      control.forEach((fn) => {
        const auth = [...new Set(fn.auth.map((item) => item.label))]
        lines.push(`  - ${fn.signature} writes=${fn.writes.join(", ") || "none"} auth=${auth.length ? auth.join(", ") : "NONE"}`)
      })
    }

    lines.push("", "Storage Gap:")
    if (!localGap.length) {
      lines.push("  local gap: none")
    }
    localGap.forEach((slot) => lines.push(`  local gap: ${slot.label} at slot ${slot.slot}`))
    if (!localGap.length && target.proxies.length) {
      warnings.push("upgradeable pattern detected without storage gap")
    }

    if (target.fallback_delegatecall) {
      warnings.push("fallback delegatecall present — verify implementation target control and initialization state")
    }

    if (warnings.length) {
      lines.push("", "Warnings:")
      const items = [...new Set(warnings)]
      items.forEach((warning) => lines.push(`  ! ${warning}`))
    }

    return {
      title: `Upgrade check: ${target.name}`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})

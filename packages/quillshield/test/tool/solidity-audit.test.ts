import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { analyzeProject } from "../../src/solidity"
import { AuthSurfaceTool } from "../../src/tool/auth-surface"
import { StateFlowTool } from "../../src/tool/state-flow"
import { StorageLayoutTool } from "../../src/tool/storage-layout"
import { UpgradeCheckTool } from "../../src/tool/upgrade-check"
import { FindingTool } from "../../src/tool/finding"
import { Session } from "../../src/session"
import { loadBuild } from "../../src/solidity/build"
import { detectProject } from "../../src/solidity/project"

const ctx = {
  sessionID: "test",
  messageID: "message",
  callID: "call",
  agent: "audit",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

function elementary(name: string, id?: number) {
  return {
    nodeType: "VariableDeclaration",
    id,
    name,
    src: "0:0:0",
    visibility: "internal",
    stateVariable: false,
    typeName: {
      nodeType: "ElementaryTypeName",
      name,
      typeDescriptions: { typeString: name },
      src: "0:0:0",
    },
    typeDescriptions: { typeString: name },
  }
}

function state(id: number, name: string, type: string) {
  return {
    nodeType: "VariableDeclaration",
    id,
    name,
    src: "0:0:0",
    visibility: "internal",
    stateVariable: true,
    constant: false,
    mutability: "mutable",
    typeName: {
      nodeType: "ElementaryTypeName",
      name: type,
      typeDescriptions: { typeString: type },
      src: "0:0:0",
    },
    typeDescriptions: { typeString: type },
  }
}

function id(name: string, ref?: number) {
  return {
    nodeType: "Identifier",
    name,
    referencedDeclaration: ref,
    src: "0:0:0",
    typeDescriptions: { typeString: "uint256" },
  }
}

function member(expression: Record<string, unknown>, memberName: string, typeString = "") {
  return {
    nodeType: "MemberAccess",
    expression,
    memberName,
    src: "0:0:0",
    typeDescriptions: { typeString },
  }
}

function call(expression: Record<string, unknown>, args: unknown[] = []) {
  return {
    nodeType: "FunctionCall",
    expression,
    arguments: args,
    src: "0:0:0",
  }
}

function expr(expression: Record<string, unknown>) {
  return {
    nodeType: "ExpressionStatement",
    expression,
    src: "0:0:0",
  }
}

function params(items: Record<string, unknown>[] = []) {
  return {
    nodeType: "ParameterList",
    parameters: items,
    src: "0:0:0",
  }
}

function func(input: {
  id: number
  name: string
  visibility?: string
  stateMutability?: string
  parameters?: Record<string, unknown>[]
  modifiers?: string[]
  body?: Record<string, unknown>[]
}) {
  return {
    nodeType: "FunctionDefinition",
    id: input.id,
    name: input.name,
    kind: "function",
    visibility: input.visibility ?? "external",
    stateMutability: input.stateMutability ?? "nonpayable",
    parameters: params(input.parameters ?? []),
    returnParameters: params(),
    modifiers: (input.modifiers ?? []).map((name) => ({
      nodeType: "ModifierInvocation",
      modifierName: { nodeType: "IdentifierPath", name, namePath: name, src: "0:0:0" },
      src: "0:0:0",
    })),
    body: {
      nodeType: "Block",
      statements: input.body ?? [],
      src: "0:0:0",
    },
    src: "0:0:0",
  }
}

function assignment(left: Record<string, unknown>, right: Record<string, unknown>) {
  return {
    nodeType: "Assignment",
    leftHandSide: left,
    rightHandSide: right,
    src: "0:0:0",
  }
}

function binary(left: Record<string, unknown>, right: Record<string, unknown>, operator: string) {
  return {
    nodeType: "BinaryOperation",
    leftExpression: left,
    rightExpression: right,
    operator,
    src: "0:0:0",
  }
}

function literal(value: string) {
  return {
    nodeType: "Literal",
    value,
    src: "0:0:0",
  }
}

function sourceUnit(nodes: Record<string, unknown>[]) {
  return {
    nodeType: "SourceUnit",
    nodes,
    src: "0:0:0",
  }
}

function contract(input: {
  id: number
  name: string
  bases?: string[]
  linearized?: number[]
  nodes: Record<string, unknown>[]
}) {
  return {
    nodeType: "ContractDefinition",
    id: input.id,
    name: input.name,
    contractKind: "contract",
    abstract: false,
    baseContracts: (input.bases ?? []).map((name) => ({
      nodeType: "InheritanceSpecifier",
      baseName: {
        nodeType: "IdentifierPath",
        name,
        namePath: name,
        src: "0:0:0",
      },
      src: "0:0:0",
    })),
    linearizedBaseContracts: input.linearized ?? [input.id],
    nodes: input.nodes,
    src: "0:0:0",
  }
}

function artifact(input: {
  name: string
  ast: Record<string, unknown>
  storage: Array<{ label: string; slot: string; offset: number; type: string }>
  types: Record<string, { label: string; numberOfBytes: string; encoding?: string }>
  methods: Record<string, string>
  source?: string
}) {
  return {
    abi: [],
    ast: input.ast,
    methodIdentifiers: input.methods,
    metadata: input.source
      ? {
          settings: {
            compilationTarget: {
              [input.source]: input.name,
            },
          },
        }
      : undefined,
    storageLayout: {
      storage: input.storage,
      types: input.types,
    },
  }
}

async function foundryFixture() {
  return tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "foundry.toml"),
        ["[profile.default]", 'src = "src"', 'out = "out"'].join("\n"),
      )

      await Bun.write(
        path.join(dir, "src/BaseVault.sol"),
        [
          "pragma solidity ^0.8.24;",
          "contract BaseVault {",
          "    address internal owner;",
          "    uint256 internal balance;",
          "    modifier onlyOwner() { require(msg.sender == owner); _; }",
          "    function deposit() external payable { balance = balance + msg.value; }",
          "}",
        ].join("\n"),
      )

      await Bun.write(
        path.join(dir, "src/Vault.sol"),
        [
          "pragma solidity ^0.8.24;",
          "contract Vault is BaseVault, Initializable, UUPSUpgradeable {",
          "    address internal treasury;",
          "    function initialize(address nextOwner) external { owner = nextOwner; }",
          "    function changeOwner(address next) external { require(msg.sender == owner); owner = next; }",
          "    function setTreasury(address next) external { treasury = next; }",
          "    function _withdraw(uint256 amount) internal { msg.sender.call{value: amount}(\"\"); balance = balance - amount; }",
          "    function withdraw(uint256 amount) external onlyOwner { _withdraw(amount); }",
          "    function upgradeTo(address impl) external {}",
          "}",
        ].join("\n"),
      )

      const base = sourceUnit([
        contract({
          id: 1,
          name: "BaseVault",
          linearized: [1],
          nodes: [
            state(11, "owner", "address"),
            state(12, "balance", "uint256"),
            {
              nodeType: "ModifierDefinition",
              id: 13,
              name: "onlyOwner",
              body: {
                nodeType: "Block",
                statements: [
                  expr(call(id("require"), [binary(member(id("msg"), "sender"), id("owner", 11), "==")])),
                  { nodeType: "PlaceholderStatement", src: "0:0:0" },
                ],
                src: "0:0:0",
              },
              src: "0:0:0",
            },
            func({
              id: 14,
              name: "deposit",
              stateMutability: "payable",
              body: [
                expr(
                  assignment(
                    id("balance", 12),
                    binary(id("balance", 12), member(id("msg"), "value"), "+"),
                  ),
                ),
              ],
            }),
          ],
        }),
      ])

      const sender = member(id("msg"), "sender", "address")
      const delegate = {
        nodeType: "FunctionCallOptions",
        expression: member(sender, "call"),
        names: ["value"],
        options: [id("amount")],
        src: "0:0:0",
      }

      const vault = sourceUnit([
        contract({
          id: 2,
          name: "Vault",
          bases: ["BaseVault", "Initializable", "UUPSUpgradeable"],
          linearized: [2, 1],
          nodes: [
            state(21, "treasury", "address"),
            func({
              id: 22,
              name: "initialize",
              parameters: [elementary("address", 31)],
              body: [expr(assignment(id("owner", 11), id("nextOwner", 31)))],
            }),
            func({
              id: 23,
              name: "changeOwner",
              parameters: [elementary("address", 35)],
              body: [
                expr(call(id("require"), [binary(member(id("msg"), "sender"), id("owner", 11), "==")])),
                expr(assignment(id("owner", 11), id("next", 35))),
              ],
            }),
            func({
              id: 24,
              name: "setTreasury",
              parameters: [elementary("address", 32)],
              body: [expr(assignment(id("treasury", 21), id("next", 32)))],
            }),
            func({
              id: 25,
              name: "_withdraw",
              visibility: "internal",
              parameters: [elementary("uint256", 33)],
              body: [
                expr(call(delegate, [literal("")])),
                expr(assignment(id("balance", 12), binary(id("balance", 12), id("amount", 33), "-"))),
              ],
            }),
            func({
              id: 26,
              name: "withdraw",
              parameters: [elementary("uint256", 33)],
              modifiers: ["onlyOwner"],
              body: [expr(call(id("_withdraw"), [id("amount", 33)]))],
            }),
            func({
              id: 27,
              name: "upgradeTo",
              parameters: [elementary("address", 34)],
              body: [],
            }),
          ],
        }),
      ])

      await Bun.write(
        path.join(dir, "out/src/BaseVault.sol/BaseVault.json"),
        JSON.stringify(
          artifact({
            name: "BaseVault",
            source: "src/BaseVault.sol",
            ast: base,
            storage: [
              { label: "owner", slot: "0", offset: 0, type: "t_address" },
              { label: "balance", slot: "1", offset: 0, type: "t_uint256" },
            ],
            types: {
              t_address: { label: "address", numberOfBytes: "20", encoding: "inplace" },
              t_uint256: { label: "uint256", numberOfBytes: "32", encoding: "inplace" },
            },
            methods: { "deposit()": "d0e30db0" },
          }),
        ),
      )

      await Bun.write(
        path.join(dir, "out/src/Vault.sol/Vault.json"),
        JSON.stringify(
          artifact({
            name: "Vault",
            source: "src/Vault.sol",
            ast: vault,
            storage: [{ label: "treasury", slot: "2", offset: 0, type: "t_address" }],
            types: {
              t_address: { label: "address", numberOfBytes: "20", encoding: "inplace" },
            },
            methods: {
              "initialize(address)": "c4d66de8",
              "changeOwner(address)": "a6f9dae1",
              "setTreasury(address)": "f0f44260",
              "withdraw(uint256)": "2e1a7d4d",
              "_withdraw(uint256)": "deadbeef",
              "upgradeTo(address)": "3659cfe6",
            },
          }),
        ),
      )
    },
  })
}

async function flattenedFixture() {
  return tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "foundry.toml"),
        ["[profile.default]", 'src = "src"', 'out = "out"', 'cache_path = "cache"'].join("\n"),
      )

      await Bun.write(
        path.join(dir, "src/external/curve/VotingEscrow.sol"),
        ["pragma solidity ^0.8.24;", "contract VotingEscrow {", "    uint256 public supply;", "}"].join("\n"),
      )

      const ast = sourceUnit([
        contract({
          id: 10,
          name: "VotingEscrow",
          linearized: [10],
          nodes: [state(101, "supply", "uint256")],
        }),
      ])

      await Bun.write(
        path.join(dir, "out/VotingEscrow.sol/VotingEscrow.json"),
        JSON.stringify(
          artifact({
            name: "VotingEscrow",
            source: "src/external/curve/VotingEscrow.sol",
            ast,
            storage: [{ label: "supply", slot: "0", offset: 0, type: "t_uint256" }],
            types: {
              t_uint256: { label: "uint256", numberOfBytes: "32", encoding: "inplace" },
            },
            methods: { "supply()": "35e7d3d8" },
          }),
        ),
      )

      await Bun.write(
        path.join(dir, "cache/solidity-files-cache.json"),
        JSON.stringify({
          files: {
            "src/external/curve/VotingEscrow.sol": {
              sourceName: "src/external/curve/VotingEscrow.sol",
              artifacts: {
                VotingEscrow: {
                  "0.8.24": {
                    default: {
                      path: "VotingEscrow.sol/VotingEscrow.json",
                      build_id: "abc",
                    },
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
}

describe("solidity audit tooling", () => {
  test("builds compiler-backed IR and analyzers from Foundry artifacts", async () => {
    await using tmp = await foundryFixture()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ir = await analyzeProject()
        expect(ir.contracts.map((contract) => contract.name)).toEqual(["BaseVault", "Vault"])

        const vault = ir.contracts.find((contract) => contract.name === "Vault")
        expect(vault).toBeDefined()
        expect(vault?.linearized_bases).toEqual(["Vault", "BaseVault"])
        expect(vault?.proxies.some((item) => item.kind === "uups")).toBe(true)

        const withdraw = vault?.functions.find((fn) => fn.name === "withdraw")
        expect(withdraw?.calls.some((call) => call.kind === "low-level")).toBe(true)
        expect(withdraw?.writes).toContain("balance")
        expect(withdraw?.auth.map((item) => item.label)).toContain("onlyOwner")
        expect(withdraw?.auth.map((item) => item.label)).not.toContain("_withdraw")

        const auth = await (await AuthSurfaceTool.init()).execute({ path: "src/Vault.sol" }, ctx)
        expect(auth.output).toContain("setTreasury(address)")
        expect(auth.output).toContain("looks sensitive")
        expect(auth.output).toContain("msg.sender == owner")

        const flow = await (await StateFlowTool.init()).execute({ path: "src/Vault.sol", function: "withdraw" }, ctx)
        expect(flow.output).toContain("external control transfer happens before a state write")

        const layout = await (await StorageLayoutTool.init()).execute({ path: "src/Vault.sol" }, ctx)
        expect(layout.output).toContain("2 |      0 |    20 | address")

        const upgrade = await (await UpgradeCheckTool.init()).execute({ path: "src/Vault.sol" }, ctx)
        expect(upgrade.output).toContain("upgradeable pattern detected without storage gap")
        expect(upgrade.output).toContain("upgradeTo(address)")
      },
    })
  })

  test("enforces evidence rules for confirmed and high-confidence findings", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const finding = await FindingTool.init()
        const result = await finding.execute(
          {
            action: "add",
            severity: "high",
            title: "Unauthorized upgrade",
            confidence: "high",
          },
          {
            ...ctx,
            sessionID: session.id,
          },
        )
        expect(result.title).toBe("Error")
        expect(result.output).toContain("High confidence requires a trace or a PoC file")
      },
    })
  })

  test("resolves flattened Foundry artifacts through compilationTarget metadata", async () => {
    await using tmp = await flattenedFixture()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const project = await detectProject(tmp.path)
        const build = await loadBuild(project)
        expect(build.contracts[0]?.source).toBe("src/external/curve/VotingEscrow.sol")
        expect(build.contracts[0]?.full).toBe(path.join(tmp.path, "src/external/curve/VotingEscrow.sol"))

        const ir = await analyzeProject()
        const contract = ir.contracts.find((item) => item.name === "VotingEscrow")
        expect(contract?.source).toBe("src/external/curve/VotingEscrow.sol")
        expect(contract?.storage[0]?.label).toBe("supply")
      },
    })
  })
})

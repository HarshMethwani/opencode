import path from "path"
import { Glob } from "@/util/glob"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import type { AstNode, BuildContract, BuildInfo, ProjectInfo, SourceInfo } from "./ir"

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" ? value : undefined
}

function sourceFull(project: ProjectInfo, file: string) {
  return path.isAbsolute(file) ? file : path.resolve(project.root, file)
}

function contractKey(file: string, name: string) {
  return `${file}:${name}`
}

function methodIds(value: unknown) {
  const result = {} as Record<string, string>
  Object.entries(object(value)).forEach(([key, item]) => {
    if (typeof item === "string") result[key] = item
  })
  return result
}

function storage(value: unknown) {
  const data = object(value)
  return {
    storage: array(data.storage)
      .map((item) => {
        const row = object(item)
        const offset = row.offset
        return {
          label: text(row.label) ?? "",
          slot: text(row.slot) ?? "0",
          offset: typeof offset === "number" ? offset : Number(offset ?? 0),
          type: text(row.type) ?? "",
          contract: text(row.contract),
        }
      })
      .filter((item) => item.label && item.type),
    types: Object.fromEntries(
      Object.entries(object(data.types)).map(([key, item]) => {
        const row = object(item)
        return [
          key,
          {
            encoding: text(row.encoding),
            label: text(row.label),
            numberOfBytes: text(row.numberOfBytes),
          },
        ]
      }),
    ),
  }
}

function parse(value: unknown) {
  if (typeof value !== "string") return object(value)
  if (!value.trim()) return {}
  try {
    return object(JSON.parse(value))
  } catch {
    return {}
  }
}

async function read(file: string) {
  return (await Bun.file(file).json()) as Record<string, unknown>
}

async function cacheMap(project: ProjectInfo) {
  const file = path.join(project.cache, "solidity-files-cache.json")
  if (!Filesystem.stat(file)?.isFile()) return new Map<string, { source: string; name: string }>()

  const json = await read(file)
  const result = new Map<string, { source: string; name: string }>()
  Object.entries(object(json.files)).forEach(([key, item]) => {
    const row = object(item)
    const source = text(row.sourceName) ?? key
    Object.entries(object(row.artifacts)).forEach(([name, versioned]) => {
      Object.values(object(versioned)).forEach((profiled) => {
        Object.values(object(profiled)).forEach((entry) => {
          const rel = text(object(entry).path)
          if (!rel) return
          result.set(rel.replaceAll("\\", "/"), {
            source,
            name,
          })
        })
      })
    })
  })
  return result
}

function target(project: ProjectInfo, artifact: string, json: Record<string, unknown>, cache: Map<string, { source: string; name: string }>) {
  const metadata = parse(json.metadata)
  const raw = parse(json.rawMetadata)
  const mapped =
    Object.entries(object(object(metadata.settings).compilationTarget))[0] ??
    Object.entries(object(object(raw.settings).compilationTarget))[0]
  if (mapped && typeof mapped[0] === "string" && typeof mapped[1] === "string") {
    return {
      source: mapped[0],
      name: mapped[1],
    }
  }

  const rel = path.relative(project.out, artifact).replaceAll(path.sep, "/")
  const cached = cache.get(rel)
  if (cached) return cached

  return {
    source: path.dirname(rel).replaceAll(path.sep, "/"),
    name: path.basename(artifact, ".json"),
  }
}

async function scan(project: ProjectInfo) {
  const artifacts = Filesystem.stat(project.out)?.isDirectory()
    ? Glob.scanSync("**/*.json", {
        cwd: project.out,
        absolute: true,
        dot: false,
        symlink: false,
      }).filter((file) => !file.endsWith(".dbg.json") && !file.includes("/build-info/"))
    : []
  const infoFiles = project.build_info.flatMap((dir) =>
    Glob.scanSync("**/*.json", {
      cwd: dir,
      absolute: true,
      dot: false,
      symlink: false,
    }),
  )
  if (!artifacts.length && !infoFiles.length) {
    throw new Error(`No Foundry build output found in ${project.out}. Run 'forge build' first.`)
  }

  const cache = await cacheMap(project)
  const sources = new Map<string, SourceInfo>()
  const meta = new Map<
    string,
    {
      abi?: unknown[]
      method_ids?: Record<string, string>
      storage?: BuildContract["storage"]
      ast?: AstNode
      source_id?: number
    }
  >()

  for (const file of infoFiles) {
    const json = await read(file)
    const output = object(json.output)
    Object.entries(object(output.sources)).forEach(([name, item]) => {
      const row = object(item)
      const full = sourceFull(project, name)
      const current = sources.get(name)
      sources.set(name, {
        path: name,
        full,
        id: num(row.id),
        ast: object(row.ast).nodeType ? (row.ast as AstNode) : current?.ast,
        content: current?.content ?? "",
      })
    })

    Object.entries(object(output.contracts)).forEach(([filePath, contracts]) => {
      Object.entries(object(contracts)).forEach(([name, item]) => {
        const row = object(item)
        meta.set(contractKey(filePath, name), {
          abi: array(row.abi),
          method_ids: methodIds(row.methodIdentifiers ?? object(row.evm).methodIdentifiers),
          storage: storage(row.storageLayout),
          ast: object(object(output.sources)[filePath]).ast as AstNode | undefined,
          source_id: num(object(object(output.sources)[filePath]).id),
        })
      })
    })
  }

  const contracts = [] as BuildContract[]
  for (const file of artifacts) {
    const json = await read(file)
    const info = target(project, file, json, cache)
    const key = contractKey(info.source, info.name)
    const extra = meta.get(key)
    const full = sourceFull(project, info.source)
    const current = sources.get(info.source)
    const ast = (object(json.ast).nodeType ? (json.ast as AstNode) : undefined) ?? extra?.ast ?? current?.ast
    const content = current?.content || (Filesystem.stat(full)?.isFile() ? await Bun.file(full).text() : "")
    sources.set(info.source, {
      path: info.source,
      full,
      ast,
      id: current?.id ?? extra?.source_id,
      content,
    })
    contracts.push({
      id: key,
      name: info.name,
      source: info.source,
      full,
      artifact: file,
      ast: (object(json.ast).nodeType ? (json.ast as AstNode) : undefined) ?? extra?.ast,
      abi: array(json.abi).length ? array(json.abi) : extra?.abi ?? [],
      method_ids: methodIds(json.methodIdentifiers ?? object(json.evm).methodIdentifiers ?? extra?.method_ids),
      storage: storage(json.storageLayout ?? extra?.storage),
    })
  }

  for (const [key, item] of meta) {
    if (contracts.some((contract) => contract.id === key)) continue
    const split = key.lastIndexOf(":")
    const source = key.slice(0, split)
    const name = key.slice(split + 1)
    const full = sourceFull(project, source)
    const current = sources.get(source)
    const content = current?.content || (Filesystem.stat(full)?.isFile() ? await Bun.file(full).text() : "")
    sources.set(source, {
      path: source,
      full,
      id: current?.id ?? item.source_id,
      ast: current?.ast ?? item.ast,
      content,
    })
    contracts.push({
      id: key,
      name,
      source,
      full,
      artifact: "",
      ast: item.ast,
      abi: item.abi ?? [],
      method_ids: item.method_ids ?? {},
      storage: item.storage ?? { storage: [], types: {} },
    })
  }

  const result = Object.fromEntries(
    await Promise.all(
      [...sources.entries()].map(async ([key, source]) => [
        key,
        source.content
          ? source
          : {
              ...source,
              content: Filesystem.stat(source.full)?.isFile() ? await Bun.file(source.full).text() : "",
            },
      ]),
    ),
  ) as Record<string, SourceInfo>

  return {
    build: {
      project,
      sources: result,
      contracts,
    } satisfies BuildInfo,
    has_ast: contracts.some((contract) => !!contract.ast) || Object.values(result).some((source) => !!source.ast),
  }
}

async function enrich(project: ProjectInfo) {
  const result = await Process.run(["forge", "build", "--ast", "--build-info"], {
    cwd: project.root,
    nothrow: true,
  })
  if (result.code === 0) return
  const stderr = result.stderr.toString().trim()
  const stdout = result.stdout.toString().trim()
  throw new Error(
    [
      "Foundry artifacts are missing compiler AST output.",
      "Tried to regenerate them with 'forge build --ast --build-info' but that failed.",
      stderr || stdout,
    ]
      .filter(Boolean)
      .join("\n"),
  )
}

export async function loadBuild(project: ProjectInfo, retry = true): Promise<BuildInfo> {
  const result = await scan(project)
  if (result.has_ast) return result.build
  if (!retry) {
    throw new Error(
      "Foundry compiler output is missing AST data. Run 'forge build --ast --build-info' and try again.",
    )
  }

  await enrich(project)
  return loadBuild(project, false)
}

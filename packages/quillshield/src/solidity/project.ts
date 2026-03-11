import path from "path"
import { Filesystem } from "@/util/filesystem"
import { Glob } from "@/util/glob"
import type { ProjectInfo } from "./ir"

function pick(text: string, key: string, fallback: string) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m"))
  return match?.[1] ?? fallback
}

function pickList(text: string, key: string, fallback: string[]) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"))
  if (!match) return fallback
  const values = match[1]!
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
  return values.length ? values : fallback
}

export async function detectProject(directory: string): Promise<ProjectInfo> {
  const config = (await Filesystem.findUp("foundry.toml", directory))[0]
  if (!config) throw new Error(`No foundry.toml found above ${directory}`)

  const root = path.dirname(config)
  const text = await Filesystem.readText(config)
  const out = path.resolve(root, pick(text, "out", "out"))
  const cache = path.resolve(root, pick(text, "cache_path", "cache"))
  const source_dirs = [path.resolve(root, pick(text, "src", "src"))].filter((dir) => Filesystem.stat(dir)?.isDirectory())
  const test_dirs = [path.resolve(root, pick(text, "test", "test"))].filter((dir) => Filesystem.stat(dir)?.isDirectory())
  const script_dirs = [path.resolve(root, pick(text, "script", "script"))].filter((dir) => Filesystem.stat(dir)?.isDirectory())
  const lib_dirs = pickList(text, "libs", ["lib"])
    .map((dir) => path.resolve(root, dir))
    .filter((dir) => Filesystem.stat(dir)?.isDirectory())
  const build_info = [
    path.join(out, "build-info"),
    path.join(root, "artifacts", "build-info"),
  ].filter((dir, idx, all) => all.indexOf(dir) === idx && Filesystem.stat(dir)?.isDirectory())

  return {
    framework: "foundry",
    root,
    config,
    out,
    cache,
    build_info,
    source_dirs,
    test_dirs,
    script_dirs,
    lib_dirs,
  }
}

export async function fingerprint(project: ProjectInfo) {
  const files = [
    project.config,
    path.join(project.cache, "solidity-files-cache.json"),
    ...Glob.scanSync("**/*.sol", {
      cwd: project.root,
      absolute: true,
      dot: false,
      symlink: false,
    }).filter((file) => !/\/(out|cache|node_modules|lib)\//.test(file)),
    ...Glob.scanSync("**/*.json", {
      cwd: project.out,
      absolute: true,
      dot: false,
      symlink: false,
    }).filter((file) => !file.endsWith(".dbg.json") && !file.includes("/build-info/")),
    ...project.build_info.flatMap((dir) =>
      Glob.scanSync("**/*.json", {
        cwd: dir,
        absolute: true,
        dot: false,
        symlink: false,
      }),
    ),
  ]

  return files
    .map((file) => {
      const stat = Filesystem.stat(file)
      return stat ? `${file}:${stat.mtimeMs}:${stat.size}` : `${file}:missing`
    })
    .join("|")
}

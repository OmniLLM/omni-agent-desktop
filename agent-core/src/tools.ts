/**
 * Local tool registry (port of src-tauri/src/agent/tools.rs).
 * Seven built-ins: read, ls, glob, grep (read-only) + write, edit, bash (mutating).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

export type ToolClass = "read-only" | "mutating";

export const LOCAL_TOOLS = ["read", "ls", "glob", "grep", "write", "edit", "bash"] as const;
export type LocalTool = (typeof LOCAL_TOOLS)[number];

const READONLY: readonly string[] = ["read", "ls", "glob", "grep"];

export function classify(tool: string): ToolClass {
  return READONLY.includes(tool) ? "read-only" : "mutating";
}

/** OpenAI-shape tool definitions ({type:"function", function:{...}}). */
export function toolDefinitions(): unknown[] {
  const def = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
  ) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  });
  return [
    def("read", "Read a UTF-8 text file.", { path: { type: "string" } }, ["path"]),
    def("ls", "List entries in a directory.", { path: { type: "string" } }, ["path"]),
    def("glob", "List files matching a glob pattern.", { pattern: { type: "string" } }, ["pattern"]),
    def(
      "grep",
      "Search files for a regex; returns matching lines.",
      { pattern: { type: "string" }, path: { type: "string" } },
      ["pattern", "path"],
    ),
    def(
      "write",
      "Create or overwrite a file with content.",
      { path: { type: "string" }, content: { type: "string" } },
      ["path", "content"],
    ),
    def(
      "edit",
      "Replace the first occurrence of old_string with new_string in a file.",
      {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      ["path", "old_string", "new_string"],
    ),
    def(
      "bash",
      "Run a shell command and return combined stdout/stderr.",
      { command: { type: "string" } },
      ["command"],
    ),
  ];
}

function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`missing string arg: ${key}`);
  return v;
}

export function executeTool(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "read":
      return readFileSync(argStr(args, "path"), "utf8");
    case "ls": {
      const path = argStr(args, "path");
      return readdirSync(path).sort().join("\n");
    }
    case "glob": {
      // Minimal glob: split pattern into dir + tail; walk dir; match tail as a
      // regex derived from ** / * / ? — sufficient for the frontend's usage
      // (recursive listings under a project root).
      const pattern = argStr(args, "pattern");
      return simpleGlob(pattern).join("\n");
    }
    case "grep": {
      const re = new RegExp(argStr(args, "pattern"));
      const root = argStr(args, "path");
      const out: string[] = [];
      walk(root, (p) => {
        try {
          const text = readFileSync(p, "utf8");
          text.split(/\r?\n/).forEach((line, i) => {
            if (re.test(line)) out.push(`${p}:${i + 1}:${line}`);
          });
        } catch {
          /* skip binary/unreadable */
        }
      });
      return out.join("\n");
    }
    case "write": {
      const path = argStr(args, "path");
      const content = argStr(args, "content");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return `wrote ${content.length} bytes to ${path}`;
    }
    case "edit": {
      const path = argStr(args, "path");
      const old = argStr(args, "old_string");
      const next = argStr(args, "new_string");
      const text = readFileSync(path, "utf8");
      if (!text.includes(old)) throw new Error(`old_string not found in ${path}`);
      writeFileSync(path, text.replace(old, next));
      return `edited ${path}`;
    }
    case "bash": {
      const command = argStr(args, "command");
      try {
        const out =
          process.platform === "win32"
            ? execFileSync("cmd.exe", ["/C", command], { encoding: "utf8" })
            : execFileSync("sh", ["-c", command], { encoding: "utf8" });
        return out;
      } catch (e) {
        const err = e as { stdout?: Buffer; stderr?: Buffer; message: string };
        const stdout = err.stdout?.toString("utf8") ?? "";
        const stderr = err.stderr?.toString("utf8") ?? err.message;
        return stdout + stderr;
      }
    }
    default:
      throw new Error(`unknown tool: ${tool}`);
  }
}

function walk(root: string, visit: (path: string) => void): void {
  try {
    const st = statSync(root);
    if (st.isFile()) return visit(root);
  } catch {
    return;
  }
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) walk(p, visit);
      else if (st.isFile()) visit(p);
    } catch {
      /* skip */
    }
  }
}

function simpleGlob(pattern: string): string[] {
  const abs = resolvePath(pattern);
  // Split into fixed prefix (up to first wildcard) + glob tail.
  const firstWild = abs.search(/[*?[]/);
  const base = firstWild < 0 ? dirname(abs) : dirname(abs.slice(0, firstWild));
  const tail = firstWild < 0 ? abs.slice(base.length + 1) : abs.slice(base.length + 1);
  const re = globToRegex(tail);
  const out: string[] = [];
  if (!existsSync(base)) return out;
  walk(base, (p) => {
    const rel = p.slice(base.length + 1).replace(/\\/g, "/");
    if (re.test(rel)) out.push(p);
  });
  return out;
}

function globToRegex(glob: string): RegExp {
  const src = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${src}$`);
}

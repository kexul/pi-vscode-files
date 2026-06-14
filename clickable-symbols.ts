/**
 * clickable-symbols.ts — symbol link renderer
 *
 * 扫描 VS Code 当前打开文件中的函数/类定义，在 pi 回复中将符号名变成可点击链接，
 * 直接跳转到定义行。排除代码块、表格行，以及 .py/.ts 等看起来像文件名的字符串。
 *
 * 命令：
 *   /symbols-reindex  — 手动重建索引
 *   /symbols-toggle   — 开关 clickable 链接渲染
 *   /symbols-stats    — 查看索引统计和开关状态
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { getOpenEditors } from "./bridge";

// ─── 类型 ────────────────────────────────────────────────

export interface SymbolDef {
  file: string;
  line: number;
  kind: string;
}

export type SymbolIndex = Map<string, SymbolDef[]>;

// ─── 工具 ────────────────────────────────────────────────

function osc8(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function vscodeUri(absPath: string, line: number): string {
  const encoded = absPath
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  return `vscode://file/${encoded}:${line}`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeFilePath(name: string): boolean {
  if (/\.(py|tsx?|jsx?|java|go|rs|cpp|c|h|hpp|cs|swift|kt|rb|php)$/i.test(name)) return true;
  if (/[/\\]/.test(name)) return true;
  return false;
}

// ─── 按语言提取符号 ───────────────────────────────────────

interface LangConf {
  re: RegExp;
  kindOf: (g: number) => string;
}

function lang(...patterns: [string, string][]): LangConf {
  const kinds = patterns.map(([, k]) => k);
  return {
    re: new RegExp(patterns.map(([p]) => p).join("|"), "gm"),
    kindOf: (g) => kinds[g - 1] ?? "sym",
  };
}

const LANGS: Record<string, LangConf> = {
  typescript: lang(
    ["(?:^|\\s)(?:export\\s+)?(?:async\\s+)?function\\s+(\\w+)", "fn"],
    ["(?:^|\\s)(?:export\\s+)?(?:async\\s+)?(?:const|let|var)\\s+(\\w+)\\s*=", "const"],
    ["(?:^|\\s)(?:export\\s+)?(?:abstract\\s+)?class\\s+(\\w+)", "class"],
    ["(?:^|\\s)(?:export\\s+)?interface\\s+(\\w+)", "interface"],
    ["(?:^|\\s)(?:export\\s+)?type\\s+(\\w+)", "type"],
    ["(?:^|\\s)(?:export\\s+)?enum\\s+(\\w+)", "enum"],
  ),
  javascript: lang(
    ["(?:^|\\s)(?:export\\s+)?(?:async\\s+)?function\\s+(\\w+)", "fn"],
    ["(?:^|\\s)(?:export\\s+)?(?:async\\s+)?(?:const|let|var)\\s+(\\w+)\\s*=", "const"],
    ["(?:^|\\s)(?:export\\s+)?class\\s+(\\w+)", "class"],
  ),
  python: lang(
    ["(?:^|\\s)(?:async\\s+)?def\\s+(\\w+)", "fn"],
    ["(?:^|\\s)class\\s+(\\w+)", "class"],
  ),
  rust: lang(
    ["(?:^|\\s)(?:pub(?:\\s*\\([^)]*\\))?\\s+)?fn\\s+(\\w+)", "fn"],
    ["(?:^|\\s)(?:pub\\s+)?struct\\s+(\\w+)", "struct"],
    ["(?:^|\\s)(?:pub\\s+)?trait\\s+(\\w+)", "trait"],
    ["(?:^|\\s)(?:pub\\s+)?enum\\s+(\\w+)", "enum"],
  ),
  go: lang(
    ["func\\s+(?:\\([^)]*\\)\\s+)?(\\w+)", "func"],
    ["type\\s+(\\w+)\\s+struct", "type"],
  ),
  java: lang(
    ["(?:public|private|protected)\\s+(?:static\\s+)?(?:final\\s+)?\\w+(?:<[^>]+>)?\\s+(\\w+)\\s*\\(", "method"],
    ["(?:public|private|protected)?\\s+(?:abstract\\s+)?class\\s+(\\w+)", "class"],
    ["(?:public|private|protected)?\\s+interface\\s+(\\w+)", "interface"],
  ),
};

const SKIP_WORDS = new Set([
  "the", "and", "for", "not", "but", "are", "all", "can", "had", "has", "was", "were",
  "will", "with", "from", "have", "this", "that", "what", "when", "where", "which",
  "they", "them", "then", "than", "some", "get", "set", "let", "var", "new", "try",
  "end", "use", "now", "add", "run", "put", "old", "see", "own", "big", "few", "key", "all",
]);

function ok(name: string): boolean {
  if (name.length < 2) return false;
  if (SKIP_WORDS.has(name.toLowerCase())) return false;
  if (looksLikeFilePath(name)) return false;
  return true;
}

// ─── 符号提取 ─────────────────────────────────────────────

function extractSymbols(filePath: string, langId: string): { name: string; def: SymbolDef }[] {
  const conf = LANGS[langId];
  if (!conf) return [];
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); } catch { return []; }
  const out: { name: string; def: SymbolDef }[] = [];
  conf.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = conf.re.exec(content)) !== null) {
    const lineNum = (content.slice(0, m.index).match(/\n/g) || []).length + 1;
    for (let i = 1; i < m.length; i++) {
      const name = m[i];
      if (!name || !ok(name)) continue;
      out.push({ name, def: { file: filePath, line: lineNum, kind: conf.kindOf(i) } });
    }
  }
  return out;
}

// ─── 构建索引 ─────────────────────────────────────────────

async function buildIndex(): Promise<{ index: SymbolIndex; files: number; symbols: number }> {
  const index: SymbolIndex = new Map();
  const editors = await getOpenEditors();
  let fileCount = 0, symCount = 0;
  for (const editor of editors) {
    if (!existsSync(editor.filePath)) continue;
    const entries = extractSymbols(editor.filePath, editor.languageId);
    if (entries.length === 0) continue;
    fileCount++;
    for (const { name, def } of entries) {
      const list = index.get(name);
      if (list) list.push(def);
      else index.set(name, [def]);
      symCount++;
    }
  }
  return { index, files: fileCount, symbols: symCount };
}

// ─── diff 行号链接 ─────────────────────────────────────────

function resolveDiffPath(relativePath: string, openFiles: string[]): string | null {
  const normalized = relativePath.replace(/\\/g, "/");
  for (const f of openFiles) {
    const nf = f.replace(/\\/g, "/");
    if (nf.endsWith("/" + normalized) || nf.endsWith(normalized)) return f;
  }
  return null;
}

function replaceDiffLinks(text: string, openFiles: string[]): string {
  let currentDiffPath: string | null = null;
  let resolvedAbsPath: string | null = null;

  return text.split("\n").map((line) => {
    const fileMatch = line.match(/^\+{3}\s+b\/(.+)$/);
    if (fileMatch) {
      currentDiffPath = fileMatch[1]!;
      resolvedAbsPath = resolveDiffPath(currentDiffPath, openFiles);
      return line;
    }

    if (!currentDiffPath) {
      const fm2 = line.match(/^---\s+a\/(.+)$/);
      if (fm2) {
        currentDiffPath = fm2[1]!;
        resolvedAbsPath = resolveDiffPath(currentDiffPath, openFiles);
      }
      return line;
    }

    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+(\+\d+)(,\d+)?\s+@@(.*)$/);
    if (hunkMatch && resolvedAbsPath) {
      const newLine = parseInt(hunkMatch[1]!.slice(1), 10);
      const uri = vscodeUri(resolvedAbsPath, newLine);
      const mid = hunkMatch[1]! + (hunkMatch[2] || "");
      const suffix = hunkMatch[3] || "";
      const left = line.slice(0, hunkMatch.index! + hunkMatch[0]!.indexOf(hunkMatch[1]!));
      return left + osc8(uri, mid) + ` @@${suffix}`;
    }

    return line;
  }).join("\n");
}

// ─── diff 结束后追加文件跳转链接 ──────────────────────────

function makeFileLink(absPath: string, line: number, prefix = "🔗"): string {
  return osc8(vscodeUri(absPath, line), `${prefix} ${basename(absPath)}:${line}`);
}

function uniqueLines(lines: number[]): number[] {
  return [...new Set(lines.filter((n) => Number.isFinite(n) && n > 0))];
}

function makeFileLinks(absPath: string, lines: number[]): string {
  const unique = uniqueLines(lines);
  return unique
    .map((line, i) => makeFileLink(absPath, line, unique.length > 1 ? `🔗${i + 1}` : "🔗"))
    .join("\n");
}

function collectUnifiedHunkLines(diffContent: string): number[] {
  const lines: number[] = [];
  const re = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diffContent)) !== null) {
    lines.push(parseInt(m[1]!, 10));
  }
  return uniqueLines(lines);
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
}

function collectRenderedDiffChangeLines(diff: string): number[] {
  const out: number[] = [];
  let inChange = false;
  let firstRemovedLine: number | null = null;
  let firstAddedLine: number | null = null;

  function flush() {
    if (!inChange) return;
    const line = firstRemovedLine ?? firstAddedLine;
    if (line !== null) out.push(line);
    inChange = false;
    firstRemovedLine = null;
    firstAddedLine = null;
  }

  for (const rawLine of diff.split("\n")) {
    const line = stripAnsi(rawLine).trimStart();
    const m = line.match(/^([+-])\s*(\d+)\s/);
    if (!m) { flush(); continue; }

    inChange = true;
    const n = parseInt(m[2]!, 10);
    if (m[1] === "-") firstRemovedLine ??= n;
    else firstAddedLine ??= n;
  }
  flush();
  return uniqueLines(out);
}

function resolveToolPath(filePath: string, openFiles: string[]): string | null {
  const fromOpenFiles = resolveDiffPath(filePath, openFiles);
  if (fromOpenFiles) return fromOpenFiles;
  const absPath = resolve(filePath);
  return existsSync(absPath) ? absPath : null;
}

function appendDiffFileLinks(text: string, openFiles: string[]): string {
  return text.replace(/```(?:diff)?\s*\r?\n([\s\S]*?)```/g, (fullMatch, codeContent) => {
    const pathMatch = codeContent.match(/^\+{3}\s+(?:b\/)?(.+)$/m);
    if (!pathMatch) return fullMatch;

    const relativePath = pathMatch[1]!;
    if (relativePath === "/dev/null") return fullMatch;

    const absPath = resolveDiffPath(relativePath, openFiles);
    if (!absPath) return fullMatch;

    const lines = collectUnifiedHunkLines(codeContent);
    const link = makeFileLinks(absPath, lines.length > 0 ? lines : [1]);

    return fullMatch + "\n" + link;
  });
}

// ─── 只在安全区域替换 ─────────────────────────────────────

function replaceSafeRegions(
  text: string,
  names: string[],
  index: SymbolIndex,
  openFiles: string[]
): string {
  let result = replaceDiffLinks(text, openFiles);
  result = appendDiffFileLinks(result, openFiles);

  if (names.length === 0) return result;

  const parts = result.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;

      let replaced = part.split("\n").map((line) => {
        if (/^\s*\|[^|]+\|/.test(line)) return line;

        interface Match {
          start: number;
          end: number;
          replacement: string;
          len: number;
        }
        const matches: Match[] = [];
        for (const name of names) {
          const defs = index.get(name)!;
          const def = defs[0]!;
          const uri = vscodeUri(def.file, def.line);
          const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "g");
          let m: RegExpExecArray | null;
          while ((m = re.exec(line)) !== null) {
            matches.push({
              start: m.index,
              end: m.index + name.length,
              replacement: osc8(uri, name),
              len: name.length,
            });
          }
        }
        if (matches.length === 0) return line;

        matches.sort((a, b) => a.start - b.start || b.len - a.len);
        const kept: Match[] = [];
        for (const m of matches) {
          const last = kept[kept.length - 1];
          if (last && m.start < last.end) {
            if (m.len > last.len) kept[kept.length - 1] = m;
          } else {
            kept.push(m);
          }
        }

        kept.sort((a, b) => b.start - a.start);
        for (const m of kept) {
          line = line.slice(0, m.start) + m.replacement + line.slice(m.end);
        }
        return line;
      }).join("\n");

      return replaced;
    })
    .join("");
}

// ─── 注册到 pi ───────────────────────────────────────────

export function registerClickableSymbols(pi: ExtensionAPI): {
  /** 获取当前打开文件路径列表（供外部 diff 匹配使用） */
  getOpenFilePaths: () => string[];
} {
  let symbolIndex: SymbolIndex = new Map();
  let openFilePaths: string[] = [];
  let ready = false;
  let enabled = true;
  let stats = { files: 0, symbols: 0 };
  let prevSnapshot = "";
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const POLL_INTERVAL_MS = 5000;

  function updateStatus(ctx?: any) {
    try {
      if (!ctx?.ui?.setStatus) return;
      if (!ready || stats.symbols === 0) {
        ctx.ui.setStatus("clickable-symbols", undefined);
        return;
      }
      const flag = enabled ? "●" : "○";
      ctx.ui.setStatus("clickable-symbols", `${flag} ${stats.symbols} sym · ${stats.files} files`);
    } catch {}
  }

  async function refresh(notify?: (msg: string, level: string) => void, ctx?: any) {
    try {
      const result = await buildIndex();
      symbolIndex = result.index;
      stats = { files: result.files, symbols: result.symbols };
      ready = result.files > 0;
      const editors = await getOpenEditors();
      openFilePaths = editors.map((e) => e.filePath);
      updateStatus(ctx);
      notify?.(`${stats.symbols} symbols · ${stats.files} files`, ready ? "success" : "info");
    } catch (e: any) {
      console.error("[clickable-symbols]", e.message);
    }
  }

  async function makeSnapshot(): Promise<string> {
    try {
      const editors = await getOpenEditors();
      return editors
        .map((e) => `${e.filePath}|${e.isDirty}`)
        .sort()
        .join("\n");
    } catch { return ""; }
  }

  let currentCtx: any = undefined;

  async function poll(): Promise<void> {
    const snap = await makeSnapshot();
    if (snap && snap !== prevSnapshot) {
      prevSnapshot = snap;
      await refresh(undefined, currentCtx);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => poll(), POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // edit 工具 diff 追加跳转链接
  pi.on("tool_result", async (event) => {
    if (!enabled) return;
    if (event.toolName !== "edit") return;

    const details = event.details as { diff?: string; firstChangedLine?: number } | undefined;
    if (!details?.diff) return;
    if (details.diff.includes("🔗")) return;

    const rawPath = (event.input as any)?.path ?? (event.input as any)?.file_path;
    if (typeof rawPath !== "string") return;

    const absPath = resolveToolPath(rawPath, openFilePaths);
    if (!absPath) return;

    const lines = collectRenderedDiffChangeLines(details.diff);
    const link = makeFileLinks(absPath, lines.length > 0 ? lines : [details.firstChangedLine ?? 1]);
    return { details: { ...details, diff: `${details.diff}\n${link}` } };
  });

  // message_end：符号 + diff 链接替换
  pi.on("message_end", async (event, _ctx) => {
    const role = event.message.role;
    if (role !== "assistant" && role !== "toolResult") return;
    if (!enabled) return;

    const doSymbols = role === "assistant" && ready && symbolIndex.size > 0;
    const names = doSymbols
      ? [...symbolIndex.keys()].sort((a, b) => b.length - a.length)
      : [];

    const content = event.message.content.map((block: any) => {
      if (block.type !== "text") return block;
      return { ...block, text: replaceSafeRegions(block.text, names, symbolIndex, openFilePaths) };
    });

    return { message: { ...event.message, content } };
  });

  // 命令
  pi.registerCommand("symbols-reindex", {
    description: "Reindex symbols from VS Code open files",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Reindexing...", "info");
      prevSnapshot = await makeSnapshot();
      await refresh((msg, level) => ctx.ui.notify(msg, level as any), ctx);
    },
  });

  pi.registerCommand("symbols-stats", {
    description: "Show symbol index stats",
    handler: async (_args, ctx) => {
      if (!ready) { ctx.ui.notify("Not indexed. /symbols-reindex", "info"); return; }
      const flag = enabled ? "● on" : "○ off";
      ctx.ui.notify(`${flag} · ${stats.symbols} symbols · ${stats.files} files`, "info");
    },
  });

  pi.registerCommand("symbols-toggle", {
    description: "Toggle clickable symbols on/off",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      updateStatus(ctx);
      const label = enabled ? "● ON" : "○ OFF";
      ctx.ui.notify(`clickable-symbols: ${label}`, enabled ? "success" : "info");
    },
  });

  // session 生命周期
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    setTimeout(async () => {
      prevSnapshot = await makeSnapshot();
      await refresh((msg) => ctx.ui.notify(`clickable-symbols: ${msg}`, "info"), ctx);
      startPolling();
    }, 1500);
  });

  pi.on("session_end", () => {
    currentCtx = undefined;
    stopPolling();
  });

  return {
    getOpenFilePaths: () => openFilePaths,
  };
}

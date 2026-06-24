/**
 * clickable-symbols.ts — VS Code jump link renderer
 *
 * 不再识别/索引函数或类等符号；仅在 pi 回复和 edit 工具结果中为 diff 追加
 * 可点击的 VS Code 跳转链接。
 *
 * 命令：
 *   /symbols-toggle — 开关 clickable 链接渲染
 *   /symbols-stats  — 查看开关状态
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { getOpenEditors } from "./bridge";

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

function replaceDiffRegions(text: string, openFiles: string[]): string {
  let result = replaceDiffLinks(text, openFiles);
  result = appendDiffFileLinks(result, openFiles);
  return result;
}

// ─── 注册到 pi ───────────────────────────────────────────

export function registerClickableSymbols(pi: ExtensionAPI): {
  /** 获取当前打开文件路径列表（供外部 diff 匹配使用） */
  getOpenFilePaths: () => string[];
} {
  let openFilePaths: string[] = [];
  let enabled = true;
  let currentCtx: any = undefined;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let prevSnapshot = "";
  const POLL_INTERVAL_MS = 5000;

  function updateStatus(ctx?: any) {
    try {
      if (!ctx?.ui?.setStatus) return;
      const flag = enabled ? "●" : "○";
      ctx.ui.setStatus("clickable-symbols", `${flag} diff links`);
    } catch {}
  }

  async function refreshOpenFiles(): Promise<void> {
    try {
      const editors = await getOpenEditors();
      openFilePaths = editors.map((e) => e.filePath);
      updateStatus(currentCtx);
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

  async function poll(): Promise<void> {
    const snap = await makeSnapshot();
    if (snap && snap !== prevSnapshot) {
      prevSnapshot = snap;
      await refreshOpenFiles();
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

  // message_end：仅处理 diff 链接，不再替换符号名
  pi.on("message_end", async (event) => {
    const role = event.message.role;
    if (role !== "assistant" && role !== "toolResult") return;
    if (!enabled) return;

    const content = event.message.content.map((block: any) => {
      if (block.type !== "text") return block;
      return { ...block, text: replaceDiffRegions(block.text, openFilePaths) };
    });

    return { message: { ...event.message, content } };
  });

  pi.registerCommand("symbols-stats", {
    description: "Show clickable diff link status",
    handler: async (_args, ctx) => {
      const flag = enabled ? "● on" : "○ off";
      ctx.ui.notify(`${flag} · diff jump links only · ${openFilePaths.length} open files`, "info");
    },
  });

  pi.registerCommand("symbols-toggle", {
    description: "Toggle clickable diff links on/off",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      updateStatus(ctx);
      const label = enabled ? "● ON" : "○ OFF";
      ctx.ui.notify(`clickable-symbols: ${label}`, enabled ? "success" : "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    setTimeout(async () => {
      prevSnapshot = await makeSnapshot();
      await refreshOpenFiles();
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

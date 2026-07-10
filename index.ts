/**
 * pi-vscode-files — main entry
 *
 * A pi extension that:
 * 1. Prioritizes VS Code open files in @ autocomplete
 * 2. Adds clickable VS Code jump links to diffs
 *
 * Requirements:
 * - pi-vscode-lite extension installed in VS Code
 * - The extension writes connection info to ~/.pi/pi-vscode-bridge/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { relative, basename, isAbsolute, sep } from "node:path";
import {
  log,
  getActiveBridgeConfig,
  getOpenEditors,
  getDiagnostics,
  type OpenEditor,
} from "./bridge";
import { registerClickableSymbols } from "./clickable-symbols";
import { registerVscodePromptQueue } from "./vscode-prompt-queue";

// ─── @ autocomplete ──────────────────────────────────────

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
  }
  return -1;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  return inQuotes ? quoteStart : null;
}

function extractAtPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart !== null && quoteStart > 0 && text[quoteStart - 1] === "@" && isTokenStart(text, quoteStart - 1)) {
    return text.slice(quoteStart - 1);
  }

  const lastDelimiterIndex = findLastDelimiter(text);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  if (text[tokenStart] === "@") return text.slice(tokenStart);
  return null;
}

function parseAtPrefix(prefix: string): { rawQuery: string; isQuotedPrefix: boolean } {
  if (prefix.startsWith('@"')) return { rawQuery: prefix.slice(2), isQuotedPrefix: true };
  return { rawQuery: prefix.slice(1), isQuotedPrefix: false };
}

function isInsideCwd(filePath: string, cwd: string): boolean {
  const relPath = relative(cwd, filePath);
  return relPath === "" || (relPath !== ".." && !relPath.startsWith(`..${sep}`) && !isAbsolute(relPath));
}

function toSuggestion(
  relativePath: string,
  label: string,
  description: string,
  isQuotedPrefix: boolean
): AutocompleteItem {
  const path = relativePath.replace(/\\/g, "/");
  const needsQuotes = isQuotedPrefix || path.includes(" ");
  return {
    value: needsQuotes ? `@"${path}"` : `@${path}`,
    label,
    description,
  };
}

function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < lowerTarget.length && qi < lowerQuery.length; ti++) {
    if (lowerTarget[ti] === lowerQuery[qi]) qi++;
  }
  return qi === lowerQuery.length;
}

function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();

  if (lowerTarget === lowerQuery) return -1000;
  if (lowerTarget.startsWith(lowerQuery)) return -500;
  if (lowerTarget.includes(lowerQuery)) return -100;

  let qi = 0;
  let gaps = 0;
  let prevMatch = -1;
  for (let ti = 0; ti < lowerTarget.length && qi < lowerQuery.length; ti++) {
    if (lowerTarget[ti] === lowerQuery[qi]) {
      if (prevMatch !== -1 && ti > prevMatch + 1) gaps += ti - prevMatch - 1;
      prevMatch = ti;
      qi++;
    }
  }
  return gaps;
}

class VscodeFilesAutocompleteProvider implements AutocompleteProvider {
  constructor(
    private readonly baseProvider: AutocompleteProvider,
    private readonly cwd: string
  ) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean }
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? "";
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    const atPrefix = extractAtPrefix(textBeforeCursor);

    if (!atPrefix) {
      return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    if (options.signal.aborted) return null;

    const { rawQuery, isQuotedPrefix } = parseAtPrefix(atPrefix);

    const openEditors = await getOpenEditors();
    if (options.signal.aborted) return null;

    const matchedEditors = openEditors
      .filter((editor) => isInsideCwd(editor.filePath, this.cwd))
      .map((editor) => {
        const relPath = relative(this.cwd, editor.filePath).replace(/\\/g, "/");
        const fileName = basename(editor.filePath);
        return { editor, relPath, fileName };
      })
      .filter(
        ({ relPath, fileName }) =>
          fuzzyMatch(rawQuery, relPath) || fuzzyMatch(rawQuery, fileName)
      )
      .sort((a, b) => {
        if (a.editor.isActive && !b.editor.isActive) return -1;
        if (!a.editor.isActive && b.editor.isActive) return 1;
        if (a.editor.isDirty && !b.editor.isDirty) return -1;
        if (!a.editor.isDirty && b.editor.isDirty) return 1;
        const scoreA = Math.min(fuzzyScore(rawQuery, a.relPath), fuzzyScore(rawQuery, a.fileName));
        const scoreB = Math.min(fuzzyScore(rawQuery, b.relPath), fuzzyScore(rawQuery, b.fileName));
        return scoreA - scoreB;
      })
      .slice(0, 10);

    if (matchedEditors.length > 0) {
      const vscodeItems: AutocompleteItem[] = matchedEditors.map(({ editor, relPath, fileName }) => {
        let desc = "📂 " + relPath;
        if (editor.isActive) desc += " ★";
        if (editor.isDirty) desc += " ●";
        return toSuggestion(relPath, fileName, desc, isQuotedPrefix);
      });

      const baseSuggestions = await this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);

      if (baseSuggestions && baseSuggestions.items.length > 0) {
        const vscodePathSet = new Set(matchedEditors.map((e) => e.relPath.toLowerCase()));
        const baseItems = baseSuggestions.items
          .filter((item) => {
            const itemPath = item.value.replace(/^@"?|"?$/g, "").toLowerCase();
            return !vscodePathSet.has(itemPath);
          })
          .slice(0, 5);

        return {
          prefix: atPrefix,
          items: [...vscodeItems, ...baseItems],
        };
      }

      return {
        prefix: atPrefix,
        items: vscodeItems,
      };
    }

    return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const candidate = this.baseProvider as AutocompleteProvider & {
      shouldTriggerFileCompletion?: (l: string[], line: number, col: number) => boolean;
    };
    return candidate.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }
}

// ─── 主入口 ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  log("=== pi-vscode-files extension LOADED ===");
  let bridgeAvailable = false;

  // 注册 diff 跳转链接功能
  registerClickableSymbols(pi);
  registerVscodePromptQueue(pi);

  pi.on("session_start", async (_event, ctx) => {
    log("session_start: checking VS Code bridge...");
    console.log("[pi-vscode-files] Session started, checking VS Code bridge...");

    const activeConfig = await getActiveBridgeConfig();
    bridgeAvailable = !!activeConfig;

    if (!bridgeAvailable) {
      return;
    }

    let editors: OpenEditor[] = [];
    try {
      editors = await Promise.race([
        getOpenEditors(),
        new Promise<OpenEditor[]>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
    } catch {
      editors = [];
    }
    if (editors.length === 0) {
      bridgeAvailable = false;
      console.log("[pi-vscode-files] Bridge reachable but no open editors found.");
      return;
    }

    const cwdEditorCount = editors.filter((editor) => isInsideCwd(editor.filePath, ctx.cwd)).length;

    // 注册 @ autocomplete provider
    ctx.ui.addAutocompleteProvider((baseProvider) => {
      return new VscodeFilesAutocompleteProvider(baseProvider, ctx.cwd);
    });

    ctx.ui.notify(`VS Code files (${cwdEditorCount}/${editors.length} in cwd) added to @ autocomplete`, "info");
  });

  // /vscode-files 命令
  pi.registerCommand("vscode-files", {
    description: "Show VS Code open files",
    handler: async (_args, ctx) => {
      log("/vscode-files command invoked");
      const config = await getActiveBridgeConfig();
      log(`/vscode-files: config=${config ? JSON.stringify({ url: config.url, pid: config.pid }) : "null"}`);
      if (!config) {
        ctx.ui.notify("VS Code bridge not available. Install pi-vscode-lite extension.", "error");
        return;
      }

      const editors = await getOpenEditors();
      if (editors.length === 0) {
        ctx.ui.notify("No files open in VS Code (or bridge not connected)", "info");
        return;
      }

      const items = editors.map((e) => {
        const relPath = relative(ctx.cwd, e.filePath).replace(/\\/g, "/");
        let label = relPath;
        if (e.isActive) label += " ★";
        if (e.isDirty) label += " ●";
        return label;
      });

      const selected = await ctx.ui.select("VS Code Open Files", items);
      if (selected) {
        const idx = items.indexOf(selected);
        if (idx >= 0) {
          const editor = editors[idx];
          const relPath = relative(ctx.cwd, editor!.filePath).replace(/\\/g, "/");
          ctx.ui.setEditorText(`@${relPath} `);
        }
      }
    },
  });

  pi.registerCommand("vscode-problems", {
    description: "Show VS Code Problems diagnostics",
    handler: async (args, ctx) => {
      const diagnostics = await getDiagnostics();
      if (diagnostics.length === 0) {
        ctx.ui.notify("No VS Code problems found.", "success");
        return;
      }

      const showAll = args.trim() === "all";
      let items = diagnostics.filter((d) => isInsideCwd(d.filePath, ctx.cwd));
      if (!showAll) {
        const active = (await getOpenEditors()).find((e) => e.isActive);
        if (active) items = items.filter((d) => d.filePath === active.filePath);
      }

      if (items.length === 0) {
        ctx.ui.notify(showAll ? "No VS Code problems in current cwd." : "No VS Code problems in active editor.", "success");
        return;
      }

      const text = items.slice(0, 100).map((d) => {
        const relPath = relative(ctx.cwd, d.filePath).replace(/\\/g, "/");
        const code = d.code !== undefined ? ` ${d.code}` : "";
        const source = d.source ? `${d.source}${code}: ` : "";
        return `${relPath}:${d.line}:${d.column} ${d.severity} ${source}${d.message}`;
      }).join("\n");

      ctx.ui.setEditorText(`${text}\n`);
      ctx.ui.notify(`Loaded ${items.length} VS Code problem(s) into editor`, "info");
    },
  });

  // /vscode-status 命令
  pi.registerCommand("vscode-status", {
    description: "Check VS Code bridge status",
    handler: async (_args, ctx) => {
      const config = await getActiveBridgeConfig();
      if (!config) {
        ctx.ui.notify("Bridge not configured. Install pi-vscode-lite in VS Code.", "warning");
        return;
      }

      const editors = await getOpenEditors();
      if (editors.length > 0) {
        ctx.ui.notify(`Bridge connected! ${editors.length} files open in VS Code.`, "success");
      } else {
        ctx.ui.notify("Bridge file exists but connection failed. Is VS Code running?", "warning");
      }
    },
  });
}

/**
 * pi-vscode-files
 *
 * A pi extension that:
 * 1. Prioritizes VS Code open files in @ autocomplete
 * 2. Opens interactive diffs for edit tool changes
 * 3. Makes symbols in AI replies clickable (from clickable-symbols)
 *
 * Requirements:
 * - pi-vscode-lite extension installed in VS Code
 * - The extension writes connection info to ~/.pi/pi-vscode-bridge/
 */

import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  TUI,
  EditorTheme,
} from "@earendil-works/pi-tui";
import { relative, basename, join, isAbsolute, sep } from "node:path";
import * as fs from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  log,
  getActiveBridgeConfig,
  getOpenEditors,
  showDiffAndWait,
  type OpenEditor,
} from "./bridge";
import { registerClickableSymbols } from "./clickable-symbols";

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

class VscodeFilesEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, private readonly cwd: string) {
    super(tui, theme, keybindings);
  }

  override setAutocompleteProvider(provider: AutocompleteProvider): void {
    super.setAutocompleteProvider(new VscodeFilesAutocompleteProvider(provider, this.cwd));
  }
}

// ─── edit tool diff 拦截 ──────────────────────────────────

const diffSessions = new Map<string, { beforePath: string; filePath: string }>();
const diffDir = join(homedir(), ".pi", "diff-cache");

function ensureDiffDir() {
  if (!fs.existsSync(diffDir)) {
    fs.mkdirSync(diffDir, { recursive: true });
  }
}

// ─── 主入口 ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  log("=== pi-vscode-files extension LOADED ===");
  let bridgeAvailable = false;

  // 注册 clickable-symbols 功能
  const symbols = registerClickableSymbols(pi);

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

  // /vscode-diff 命令
  pi.registerCommand("vscode-diff", {
    description: "Open diff in VS Code and wait for accept/reject. Usage: /vscode-diff <file1> <file2>",
    handler: async (args, ctx) => {
      const config = await getActiveBridgeConfig();
      if (!config) {
        ctx.ui.notify("VS Code bridge not available. Install pi-vscode-lite extension.", "error");
        return;
      }

      const parts = args.split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, ""));
      let file1: string | undefined;
      let file2: string | undefined;

      if (parts.length === 2) {
        file1 = parts[0];
        file2 = parts[1];
      } else {
        const words = args.split(/\s+/);
        if (words.length >= 2) {
          file1 = words.slice(0, -1).join(" ").replace(/^["']|["']$/g, "");
          file2 = words[words.length - 1].replace(/^["']|["']$/g, "");
        }
      }

      if (!file1 || !file2) {
        ctx.ui.notify("Usage: /vscode-diff <file1> <file2> - provide two file paths", "error");
        return;
      }

      if (!isAbsolute(file1)) file1 = join(ctx.cwd, file1);
      if (!isAbsolute(file2)) file2 = join(ctx.cwd, file2);

      if (!existsSync(file1)) {
        ctx.ui.notify(`File not found: ${file1}`, "error");
        return;
      }
      if (!existsSync(file2)) {
        ctx.ui.notify(`File not found: ${file2}`, "error");
        return;
      }

      ctx.ui.notify("Opening diff in VS Code...", "info");

      const result = await showDiffAndWait(file1, file2);

      if (result === null) {
        ctx.ui.notify("Failed to connect to VS Code bridge.", "error");
      } else if (result.timedOut) {
        ctx.ui.notify("⏰ Timed out waiting for your decision.", "warning");
      } else if (result.accepted) {
        ctx.ui.notify("✅ Changes accepted!", "success");
      } else {
        ctx.ui.notify("❌ Changes rejected.", "info");
      }
    },
  });

  // edit tool 拦截：在 VS Code 中展示 diff
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit") return;

    let filePath: string = event.input?.path;
    if (!filePath) return;
    if (!isAbsolute(filePath)) filePath = join(ctx.cwd, filePath);
    if (!fs.existsSync(filePath)) return;

    ensureDiffDir();
    const base = basename(filePath);
    const beforePath = join(diffDir, `${base}.before.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.copyFileSync(filePath, beforePath);
    diffSessions.set(event.toolCallId, { beforePath, filePath });
  });

  pi.on("tool_result", async (event, ctx) => {
    const session = diffSessions.get(event.toolCallId);
    if (!session) return;
    diffSessions.delete(event.toolCallId);

    const { beforePath, filePath } = session;

    try {
      const original = fs.readFileSync(beforePath, "utf-8");
      const modified = fs.readFileSync(filePath, "utf-8");

      if (original === modified) {
        try { fs.unlinkSync(beforePath); } catch {}
        return;
      }

      const config = await getActiveBridgeConfig();
      if (config) {
        ctx.ui.notify("📋 Review changes in VS Code...", "info");

        const result = await showDiffAndWait(beforePath, filePath);

        if (result && !result.accepted && !result.timedOut) {
          ctx.ui.notify("❌ Changes rejected, file restored.", "info");
          fs.writeFileSync(filePath, original, "utf-8");
          try { fs.unlinkSync(beforePath); } catch {}
          ctx.abort();
          return {
            isError: true,
            content: [{ type: "text", text: "❌ Changes rejected by user. Agent stopped. File restored to original." }],
          };
        } else if (result && result.autoAccepted) {
          ctx.ui.notify("⚠️ No VS Code window has this file's workspace. Changes applied without review.", "warning");
        } else if (result && (result.accepted || result.timedOut)) {
          if (result.timedOut) {
            ctx.ui.notify("⏰ Diff timed out, changes kept.", "warning");
          } else {
            ctx.ui.notify("✅ Changes accepted.", "success");
          }
        }
      }

      setTimeout(() => {
        try { fs.unlinkSync(beforePath); } catch {}
      }, 5000);
    } catch (e) {
      try { fs.unlinkSync(beforePath); } catch {}
    }
  });
}

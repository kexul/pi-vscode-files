/**
 * pi-vscode-files
 *
 * A pi extension that prioritizes VS Code open files in @ autocomplete.
 * When you type @xxx, open files in VS Code will appear at the top of suggestions.
 *
 * Requirements:
 * - pi-vscode-lite extension installed in VS Code
 * - The extension writes connection info to ~/.pi/vscode-bridge.json
 */

import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  TUI,
  EditorTheme,
} from "@mariozechner/pi-tui";
import { relative, basename, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

interface BridgeConfig {
  url: string;
  token: string;
  pid: number;
  timestamp: number;
}

interface OpenEditor {
  filePath: string;
  languageId: string;
  isDirty: boolean;
  isActive: boolean;
}

// Read bridge config from ~/.pi/vscode-bridge.json
function getBridgeConfig(): BridgeConfig | null {
  const bridgeFile = join(homedir(), ".pi", "vscode-bridge.json");
  if (!existsSync(bridgeFile)) return null;
  
  try {
    const content = readFileSync(bridgeFile, "utf8");
    const config = JSON.parse(content) as BridgeConfig;
    
    // Check if config is fresh (within last 24 hours)
    if (Date.now() - config.timestamp > 24 * 60 * 60 * 1000) {
      return null;
    }
    
    return config;
  } catch {
    return null;
  }
}

// Call VS Code bridge to get open editors
async function getOpenEditors(): Promise<OpenEditor[]> {
  const config = getBridgeConfig();
  if (!config) return [];

  try {
    const response = await fetch(`${config.url}/open-editors`, {
      method: "GET",
      headers: {
        "X-Token": config.token,
      },
    });

    if (!response.ok) return [];
    return (await response.json()) as OpenEditor[];
  } catch {
    return [];
  }
}

// Token delimiters for @ prefix detection
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

// Simple fuzzy match: check if query chars appear in order in target
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

// Score for sorting: lower is better
function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();

  // Exact match gets best score
  if (lowerTarget === lowerQuery) return -1000;
  if (lowerTarget.startsWith(lowerQuery)) return -500;
  if (lowerTarget.includes(lowerQuery)) return -100;

  // Count matched chars and gaps
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

    // If not an @ prefix, delegate to base provider
    if (!atPrefix) {
      return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    if (options.signal.aborted) return null;

    const { rawQuery, isQuotedPrefix } = parseAtPrefix(atPrefix);

    // Get open editors from VS Code
    const openEditors = await getOpenEditors();
    if (options.signal.aborted) return null;

    // Filter and sort by fuzzy match
    const matchedEditors = openEditors
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
        // Active editor first
        if (a.editor.isActive && !b.editor.isActive) return -1;
        if (!a.editor.isActive && b.editor.isActive) return 1;
        // Then dirty files
        if (a.editor.isDirty && !b.editor.isDirty) return -1;
        if (!a.editor.isDirty && b.editor.isDirty) return 1;
        // Then by fuzzy score
        const scoreA = Math.min(fuzzyScore(rawQuery, a.relPath), fuzzyScore(rawQuery, a.fileName));
        const scoreB = Math.min(fuzzyScore(rawQuery, b.relPath), fuzzyScore(rawQuery, b.fileName));
        return scoreA - scoreB;
      })
      .slice(0, 10);

    // If we have VS Code results, return them (combined with base provider results if needed)
    if (matchedEditors.length > 0) {
      const vscodeItems: AutocompleteItem[] = matchedEditors.map(({ editor, relPath, fileName }) => {
        let desc = "📂 " + relPath;
        if (editor.isActive) desc += " ★";
        if (editor.isDirty) desc += " ●";
        return toSuggestion(relPath, fileName, desc, isQuotedPrefix);
      });

      // Also get base suggestions and merge
      const baseSuggestions = await this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
      
      if (baseSuggestions && baseSuggestions.items.length > 0) {
        // Filter out duplicates from base suggestions
        const vscodePathSet = new Set(matchedEditors.map(e => e.relPath.toLowerCase()));
        const baseItems = baseSuggestions.items.filter(item => {
          const itemPath = item.value.replace(/^@"?|"?$/g, "").toLowerCase();
          return !vscodePathSet.has(itemPath);
        }).slice(0, 5); // Limit base suggestions
        
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

    // Fall back to base provider if no VS Code results
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

export default function (pi: ExtensionAPI) {
  let bridgeAvailable = false;

  pi.on("session_start", async (_event, ctx) => {
    // Check if bridge is available
    const config = getBridgeConfig();
    bridgeAvailable = !!config;

    if (!bridgeAvailable) {
      // No bridge, extension is inactive but don't spam notifications
      return;
    }

    // Test connection
    const editors = await getOpenEditors();
    if (editors.length === 0) {
      // Bridge file exists but connection failed - might be stale
      bridgeAvailable = false;
      return;
    }

    // Set custom editor with VS Code file autocomplete
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new VscodeFilesEditor(tui, theme, keybindings, ctx.cwd));

    ctx.ui.notify(`VS Code files (${editors.length}) added to @ autocomplete`, "info");
  });

  // Register a command to show open editors
  pi.registerCommand("vscode-files", {
    description: "Show VS Code open files",
    handler: async (_args, ctx) => {
      const config = getBridgeConfig();
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

  // Register a command to check bridge status
  pi.registerCommand("vscode-status", {
    description: "Check VS Code bridge status",
    handler: async (_args, ctx) => {
      const config = getBridgeConfig();
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

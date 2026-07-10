/**
 * vscode-prompt-queue.ts — receive prompt drafts from VS Code commands
 *
 * VS Code writes JSONL requests to ~/.pi/pi-vscode-bridge/prompt-queue.jsonl.
 * This pi extension tails new entries and applies them to the pi editor.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, openSync, closeSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./bridge";

type PromptAction = "setEditorText" | "appendEditorText" | "sendUserMessage";

interface PromptRequest {
  id?: string;
  action?: PromptAction;
  text?: string;
  createdAt?: number;
  source?: string;
}

const QUEUE_FILE = join(homedir(), ".pi", "pi-vscode-bridge", "prompt-queue.jsonl");
const POLL_INTERVAL_MS = 800;
const MAX_SEEN_IDS = 500;

function readNewQueueData(offset: number): { text: string; nextOffset: number } {
  if (!existsSync(QUEUE_FILE)) return { text: "", nextOffset: 0 };

  const size = statSync(QUEUE_FILE).size;
  if (size < offset) offset = 0;
  if (size === offset) return { text: "", nextOffset: offset };

  const fd = openSync(QUEUE_FILE, "r");
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return { text: buffer.toString("utf8"), nextOffset: size };
  } finally {
    closeSync(fd);
  }
}

function rememberId(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size <= MAX_SEEN_IDS) return;
  const first = seen.values().next().value;
  if (first) seen.delete(first);
}

async function applyPromptRequest(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  req: PromptRequest
): Promise<void> {
  const text = req.text;
  if (typeof text !== "string" || text.trim() === "") return;

  const action = req.action ?? "setEditorText";
  if (action === "appendEditorText") {
    const current = ctx.ui.getEditorText?.() ?? "";
    const separator = current.trim() ? "\n\n" : "";
    ctx.ui.setEditorText(current + separator + text);
    ctx.ui.notify("Added VS Code context to pi editor", "success");
    return;
  }

  if (action === "sendUserMessage") {
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
    return;
  }

  ctx.ui.setEditorText(text);
  ctx.ui.notify("Loaded VS Code prompt into pi editor", "success");
}

export function registerVscodePromptQueue(pi: ExtensionAPI): void {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let offset = 0;
  let remainder = "";
  const seenIds = new Set<string>();

  async function poll(ctx: ExtensionContext): Promise<void> {
    try {
      const chunk = readNewQueueData(offset);
      offset = chunk.nextOffset;
      if (!chunk.text) return;

      const combined = remainder + chunk.text;
      const lines = combined.split(/\r?\n/);
      remainder = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const req = JSON.parse(line) as PromptRequest;
        if (req.id && seenIds.has(req.id)) continue;
        if (req.id) rememberId(seenIds, req.id);
        await applyPromptRequest(pi, ctx, req);
      }
    } catch (e: any) {
      log(`prompt queue poll error: ${e?.message || e}`);
    }
  }

  function stopPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      offset = existsSync(QUEUE_FILE) ? statSync(QUEUE_FILE).size : 0;
    } catch {
      offset = 0;
    }
    remainder = "";
    stopPolling();
    pollTimer = setInterval(() => void poll(ctx), POLL_INTERVAL_MS);
  });

  pi.on("session_shutdown", () => stopPolling());
  pi.on("session_end", () => stopPolling());
}

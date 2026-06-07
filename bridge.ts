/**
 * bridge.ts
 *
 * Shared VS Code bridge utilities used by both @ autocomplete and clickable-symbols.
 */

import { readFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── 日志 ────────────────────────────────────────────────

const LOG_FILE = join(homedir(), ".pi", "pi-vscode-debug.log");
export function log(msg: string) {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch {}
}

// ─── 类型 ────────────────────────────────────────────────

export interface BridgeConfig {
  url: string;
  token: string;
  pid: number;
  timestamp: number;
  workspaceFolders?: string[];
}

export interface OpenEditor {
  filePath: string;
  languageId: string;
  isDirty: boolean;
  isActive: boolean;
}

// ─── fetch 超时 ──────────────────────────────────────────

export function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    fetch(url, { ...options, signal: controller.signal })
      .then((res) => { clearTimeout(timer); resolve(res); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

// ─── 桥接配置读取 ─────────────────────────────────────────

export function getBridgeConfigs(): BridgeConfig[] {
  const bridgeDir = join(homedir(), ".pi", "pi-vscode-bridge");
  const legacyFile = join(homedir(), ".pi", "vscode-bridge.json");
  log(`getBridgeConfigs: bridgeDir=${bridgeDir}, exists=${existsSync(bridgeDir)}`);
  const configs: BridgeConfig[] = [];

  if (existsSync(bridgeDir)) {
    try {
      const names = readdirSync(bridgeDir);
      log(`getBridgeConfigs: readdir returned ${names.length} entries: [${names.join(", ")}]`);
      for (const name of names) {
        if (!name.endsWith(".json")) {
          log(`getBridgeConfigs: skipping non-json: ${name}`);
          continue;
        }
        const filePath = join(bridgeDir, name);
        try {
          const raw = readFileSync(filePath, "utf8");
          log(`getBridgeConfigs: file ${name} content: ${raw.trim()}`);
          const data = JSON.parse(raw);
          log(`getBridgeConfigs: ACCEPTED ${name} (probeBridge will verify connectivity)`);
          configs.push(data);
        } catch (e: any) {
          log(`getBridgeConfigs: PARSE ERROR ${name}: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      log(`getBridgeConfigs: READDIR ERROR: ${e?.message || e}`);
    }
    if (configs.length > 0) return configs.sort((a, b) => b.timestamp - a.timestamp);
  }

  if (!existsSync(legacyFile)) return [];
  try {
    const content = readFileSync(legacyFile, "utf8");
    const parsed = JSON.parse(content);
    const legacy: BridgeConfig[] = Array.isArray(parsed) ? parsed : [parsed];
    return legacy.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

// ─── 桥接连通性检测 ───────────────────────────────────────

export async function probeBridge(config: BridgeConfig): Promise<boolean> {
  try {
    log(`probeBridge: trying ${config.url}/health`);
    const response = await fetchWithTimeout(`${config.url}/health`, {
      method: "GET",
      headers: { "X-Token": config.token },
    }, 2000);
    log(`probeBridge: /health status=${response.status}, ok=${response.ok}`);
    if (response.ok) return true;
    const fallback = await fetchWithTimeout(`${config.url}/open-editors`, {
      method: "GET",
      headers: { "X-Token": config.token },
    }, 2000);
    log(`probeBridge: /open-editors fallback status=${fallback.status}`);
    return fallback.ok;
  } catch (e: any) {
    log(`probeBridge: ERROR ${e?.message || e}`);
    return false;
  }
}

export async function getActiveBridgeConfigs(): Promise<BridgeConfig[]> {
  const allConfigs = getBridgeConfigs();
  if (allConfigs.length === 0) return [];

  const results = await Promise.allSettled(
    allConfigs.map(async (config) => {
      const reachable = await probeBridge(config);
      return reachable ? config : null;
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<BridgeConfig | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((c): c is BridgeConfig => c !== null);
}

export async function getActiveBridgeConfig(): Promise<BridgeConfig | null> {
  const active = await getActiveBridgeConfigs();
  log(`getActiveBridgeConfig: found ${active.length} active bridge(s)`);
  return active[0] ?? null;
}

// ─── 获取打开的编辑器 ─────────────────────────────────────

export async function getOpenEditors(): Promise<OpenEditor[]> {
  const configs = await getActiveBridgeConfigs();
  if (configs.length === 0) return [];

  const seen = new Map<string, OpenEditor>();

  const results = await Promise.allSettled(
    configs.map(async (config) => {
      try {
        const response = await fetchWithTimeout(`${config.url}/open-editors`, {
          method: "GET",
          headers: { "X-Token": config.token },
        }, 3000);
        if (!response.ok) return [];
        return (await response.json()) as OpenEditor[];
      } catch {
        return [];
      }
    })
  );

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const editor of result.value) {
      const key = editor.filePath;
      if (!seen.has(key)) {
        seen.set(key, editor);
      } else {
        const existing = seen.get(key)!;
        if (editor.isActive) existing.isActive = true;
        if (editor.isDirty) existing.isDirty = true;
      }
    }
  }

  return [...seen.values()];
}

// ─── 工作区匹配 ──────────────────────────────────────────

export function fileBelongsToWorkspace(filePath: string, config: BridgeConfig): boolean {
  if (!config.workspaceFolders || config.workspaceFolders.length === 0) return false;
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return config.workspaceFolders.some((folder) => {
    const folderNorm = folder.replace(/\\/g, "/").toLowerCase();
    return normalized === folderNorm || normalized.startsWith(folderNorm + "/");
  });
}

// ─── diff-and-wait ───────────────────────────────────────

export async function showDiffAndWait(
  file1: string,
  file2: string,
  timeout: number = 3600
): Promise<{ accepted: boolean; timedOut: boolean; autoAccepted?: boolean } | null> {
  const configs = await getActiveBridgeConfigs();
  if (configs.length === 0) return null;

  const targetConfig = configs.find((c) => fileBelongsToWorkspace(file2, c));

  if (!targetConfig) {
    return { accepted: true, timedOut: false, autoAccepted: true };
  }

  try {
    const response = await fetchWithTimeout(
      `${targetConfig.url}/diff-and-wait`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Token": targetConfig.token,
        },
        body: JSON.stringify({ file1, file2, timeout }),
      },
      (timeout + 5) * 1000
    );

    if (!response.ok) return null;
    return (await response.json()) as {
      accepted: boolean;
      timedOut: boolean;
      autoAccepted?: boolean;
    };
  } catch {
    return null;
  }
}

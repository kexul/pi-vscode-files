const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let server = null;
let token = null;
const PID = process.pid;

const PI_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.pi');
const BRIDGE_DIR = path.join(PI_DIR, 'pi-vscode-bridge');
const BRIDGE_FILE = path.join(BRIDGE_DIR, `${PID}.json`);
const PROMPT_QUEUE_FILE = path.join(BRIDGE_DIR, 'prompt-queue.jsonl');

// Write this window's bridge config to its own per-PID file.
// No read-modify-write needed — each window owns its file exclusively.
function registerBridge(url) {
    try {
        ensureBridgeDir();
        // Write to temp file first, then rename for atomicity
        const tmpFile = BRIDGE_FILE + '.tmp';
        const workspaceFolders = vscode.workspace.workspaceFolders
            ? vscode.workspace.workspaceFolders.map(f => f.uri.fsPath)
            : [];
        fs.writeFileSync(tmpFile, JSON.stringify({
            url,
            token,
            pid: PID,
            timestamp: Date.now(),
            workspaceFolders
        }, null, 2));
        fs.renameSync(tmpFile, BRIDGE_FILE);
    } catch {
        // Silently ignore write errors
    }
}

// Remove this window's bridge file on deactivate
function unregisterBridge() {
    try {
        if (fs.existsSync(BRIDGE_FILE)) {
            fs.unlinkSync(BRIDGE_FILE);
        }
    } catch {
        // Silently ignore cleanup errors
    }
}

function ensureBridgeDir() {
    if (!fs.existsSync(BRIDGE_DIR)) {
        fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    }
}

function severityToString(severity) {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error: return 'error';
        case vscode.DiagnosticSeverity.Warning: return 'warning';
        case vscode.DiagnosticSeverity.Information: return 'information';
        case vscode.DiagnosticSeverity.Hint: return 'hint';
        default: return 'unknown';
    }
}

function diagnosticCodeToString(code) {
    if (code === undefined || code === null) return undefined;
    if (typeof code === 'object') return code.value ?? JSON.stringify(code);
    return code;
}

function getDiagnostics() {
    const out = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') continue;
        for (const diagnostic of diagnostics) {
            out.push({
                filePath: uri.fsPath,
                line: diagnostic.range.start.line + 1,
                column: diagnostic.range.start.character + 1,
                endLine: diagnostic.range.end.line + 1,
                endColumn: diagnostic.range.end.character + 1,
                severity: severityToString(diagnostic.severity),
                message: diagnostic.message,
                source: diagnostic.source,
                code: diagnosticCodeToString(diagnostic.code)
            });
        }
    }
    return out;
}

function getWorkspaceRelativePath(filePath) {
    const folders = vscode.workspace.workspaceFolders || [];
    let best = null;
    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const rel = path.relative(root, filePath);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            if (!best || rel.length < best.length) best = rel;
        }
    }
    return best || filePath;
}

function escapePromptPath(filePath) {
    const normalized = getWorkspaceRelativePath(filePath).replace(/\\/g, '/');
    return normalized.includes(' ') ? `@"${normalized}"` : `@${normalized}`;
}

function selectionRangeText(selection) {
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function getActiveEditorContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const document = editor.document;
    const fileRef = escapePromptPath(document.uri.fsPath);
    const selection = editor.selection;
    const selectedText = document.getText(selection);
    const hasSelection = !selection.isEmpty && selectedText.trim() !== '';
    const range = selectionRangeText(selection);
    return { editor, document, fileRef, selectedText, hasSelection, range };
}

function enqueuePiPrompt(text, action = 'sendUserMessage') {
    ensureBridgeDir();
    const entry = {
        id: `${PID}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        source: 'vscode',
        action,
        text,
        createdAt: Date.now()
    };
    fs.appendFileSync(PROMPT_QUEUE_FILE, JSON.stringify(entry) + '\n');
}

function buildAskSelectionPrompt(userText) {
    const context = getActiveEditorContext();
    if (!context) return null;

    const { document, fileRef, selectedText, hasSelection, range } = context;
    const codeText = hasSelection ? selectedText : document.lineAt(context.editor.selection.active.line).text;
    const codeLabel = hasSelection ? `selected code in ${fileRef} (${range})` : `current line in ${fileRef} (${range})`;
    return `${userText}\n\nContext: ${codeLabel}\n\n\`\`\`${document.languageId}\n${codeText}\n\`\`\`\n`;
}

async function askSelectionAndSend() {
    const userText = await vscode.window.showInputBox({
        title: 'Ask pi about selection',
        prompt: 'Your message will be sent to pi together with the selected code.',
        placeHolder: 'e.g. Explain this, fix the bug, add tests...',
        ignoreFocusOut: true
    });
    if (userText === undefined) return;
    if (userText.trim() === '') {
        vscode.window.showWarningMessage('Pi: message is empty.');
        return;
    }

    const text = buildAskSelectionPrompt(userText.trim());
    if (!text) {
        vscode.window.showWarningMessage('Pi: no active editor.');
        return;
    }
    enqueuePiPrompt(text, 'sendUserMessage');
    vscode.window.showInformationMessage('Sent message to pi.');
}

function getOpenEditors() {
    const seen = new Map();
    const schemeFilter = (uri) => uri.scheme === 'file' || uri.scheme === 'vscode-remote';

    // Visible editors
    for (const editor of vscode.window.visibleTextEditors) {
        if (!schemeFilter(editor.document.uri)) continue;
        seen.set(editor.document.uri.toString(), {
            filePath: editor.document.uri.fsPath,
            languageId: editor.document.languageId,
            isDirty: editor.document.isDirty,
            isActive: editor === vscode.window.activeTextEditor
        });
    }

    // All open documents (including background tabs)
    for (const document of vscode.workspace.textDocuments) {
        if (!schemeFilter(document.uri)) continue;
        if (seen.has(document.uri.toString())) continue;
        seen.set(document.uri.toString(), {
            filePath: document.uri.fsPath,
            languageId: document.languageId,
            isDirty: document.isDirty,
            isActive: vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()
        });
    }

    // Also check open tabs that might be preview and not yet in textDocuments
    for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
            const input = tab.input;
            if (!input || !input.uri) continue;
            const uri = input.uri;
            if (!schemeFilter(uri)) continue;
            if (seen.has(uri.toString())) continue;
            seen.set(uri.toString(), {
                filePath: uri.fsPath,
                languageId: 'unknown',
                isDirty: tab.isDirty || false,
                isActive: tab.isActive
            });
        }
    }

    return [...seen.values()];
}

function activate(context) {
    // Generate token
    token = crypto.randomBytes(16).toString('hex');

    // Find available port
    server = http.createServer(async (req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // Check token
        if (req.headers['x-token'] !== token) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        // Handle requests
        if (req.url === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', pid: PID }));
        } else if (req.url === '/open-editors' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(getOpenEditors()));
        } else if (req.url === '/diagnostics' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(getDiagnostics()));
        } else if (req.url === '/workspace-folders' && req.method === 'GET') {
            const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(folders));
        } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    });

    server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        const url = `http://127.0.0.1:${port}`;

        registerBridge(url);

        console.log(`Pi VS Code Lite bridge running on port ${port} (PID: ${PID})`);
    });

    context.subscriptions.push(vscode.commands.registerCommand('pi-vscode-lite.askSelectionAndSend', askSelectionAndSend));

    // Clean up on deactivate: remove only this window's entry
    context.subscriptions.push({
        dispose() {
            if (server) {
                server.close();
            }
            unregisterBridge();
        }
    });
}

function deactivate() {
    if (server) {
        server.close();
    }
}

module.exports = { activate, deactivate };

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
const BEFORE_DIFF_SCHEME = 'pi-diff-before';
const beforeDiffContents = new Map();
let diffReviewController = null;

class DiffReviewController {
    constructor(context) {
        this.pending = null;
        this.resolvePending = null;
        this.acceptItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
        this.rejectItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9999);
        this.infoItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9998);

        this.acceptItem.text = '$(check) Accept Pi Edit';
        this.acceptItem.tooltip = 'Accept the pending Pi edit';
        this.acceptItem.command = 'piDiffReview.accept';

        this.rejectItem.text = '$(close) Reject Pi Edit';
        this.rejectItem.tooltip = 'Reject the pending Pi edit and restore the original file';
        this.rejectItem.command = 'piDiffReview.reject';

        this.infoItem.text = '$(diff) Pi Review';

        context.subscriptions.push(
            this.acceptItem,
            this.rejectItem,
            this.infoItem,
            vscode.commands.registerCommand('piDiffReview.accept', () => this.decide('\u2705 Accept')),
            vscode.commands.registerCommand('piDiffReview.reject', () => this.decide('\u274c Reject'))
        );
    }

    async ask({ filePath, timeoutMs }) {
        this.pending = { filePath, timeoutMs };
        this.show(filePath);

        let resolved = false;
        return await new Promise(resolve => {
            const timer = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                this.resolvePending = null;
                this.pending = null;
                this.hide();
                resolve('timeout');
            }, timeoutMs);

            this.resolvePending = (value) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                this.resolvePending = null;
                this.pending = null;
                this.hide();
                resolve(value);
            };
        });
    }

    decide(value) {
        if (this.resolvePending) this.resolvePending(value);
    }

    show(filePath) {
        const fileName = path.basename(filePath);
        this.infoItem.tooltip = `Review Pi edit: ${filePath}`;
        this.infoItem.text = `$(diff) Pi Review: ${fileName}`;
        this.infoItem.show();
        this.rejectItem.show();
        this.acceptItem.show();
    }

    hide() {
        this.acceptItem.hide();
        this.rejectItem.hide();
        this.infoItem.hide();
    }
}

function createBeforeDiffUri(file1, file2) {
    const id = crypto.randomUUID();
    beforeDiffContents.set(id, fs.readFileSync(file1, 'utf-8'));
    const name = `${path.basename(file2)}.before`;
    return {
        id,
        uri: vscode.Uri.from({ scheme: BEFORE_DIFF_SCHEME, path: `/${name}`, query: id })
    };
}

function cleanupBeforeDiffContent(id) {
    if (id) beforeDiffContents.delete(id);
}

// Write this window's bridge config to its own per-PID file.
// No read-modify-write needed — each window owns its file exclusively.
function registerBridge(url) {
    try {
        if (!fs.existsSync(BRIDGE_DIR)) {
            fs.mkdirSync(BRIDGE_DIR, { recursive: true });
        }
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

// Check if a file path belongs to the current workspace.
// Comparison is case-insensitive on Windows (path.normalize preserves case).
function isInWorkspace(filePath) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return false;
    const normalizedPath = path.normalize(filePath);
    for (const folder of folders) {
        const folderPath = path.normalize(folder.uri.fsPath);
        // Case-insensitive comparison for cross-platform compatibility
        const prefix = (folderPath + path.sep).toLowerCase();
        if (normalizedPath.toLowerCase().startsWith(prefix) ||
            normalizedPath.toLowerCase() === folderPath.toLowerCase()) {
            return true;
        }
    }
    return false;
}

// Find the first line that differs between two files (0-indexed)
function findFirstChangedLine(file1, file2) {
    try {
        const lines1 = fs.readFileSync(file1, 'utf-8').split('\n');
        const lines2 = fs.readFileSync(file2, 'utf-8').split('\n');
        const minLen = Math.min(lines1.length, lines2.length);
        for (let i = 0; i < minLen; i++) {
            if (lines1[i] !== lines2[i]) return i;
        }
        // All common lines same, change is extra lines in file2
        if (lines2.length > lines1.length) return lines1.length;
        return 0;
    } catch {
        return 0;
    }
}

function activate(context) {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BEFORE_DIFF_SCHEME, {
        provideTextDocumentContent(uri) {
            return beforeDiffContents.get(uri.query) || '';
        }
    }));

    diffReviewController = new DiffReviewController(context);

    // Generate token
    token = crypto.randomBytes(16).toString('hex');
    
    // Find available port
    server = http.createServer((req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
        
        // Helper: collect request body as JSON
        function readJsonBody(req) {
            return new Promise((resolve, reject) => {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(new Error('Invalid JSON')); }
                });
                req.on('error', reject);
            });
        }

        // Handle requests
        if (req.url === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', pid: PID }));
        } else if (req.url === '/open-editors' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(getOpenEditors()));
        } else if (req.url === '/workspace-folders' && req.method === 'GET') {
            const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(folders));
        } else if (req.url === '/diff' && req.method === 'POST') {
            readJsonBody(req).then(body => {
                const { file1, file2 } = body;
                if (!file1 || !file2) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Both file1 and file2 are required' }));
                    return;
                }
                // Only open diff if the file belongs to the current workspace
                if (!isInWorkspace(file2)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, skipped: 'not_in_workspace' }));
                    return;
                }
                const before = createBeforeDiffUri(file1, file2);
                vscode.commands.executeCommand('vscode.diff',
                    before.uri,
                    vscode.Uri.file(file2),
                    `${path.basename(file2)} (before) \u2194 ${path.basename(file2)}`
                );
                setTimeout(() => cleanupBeforeDiffContent(before.id), 60 * 60 * 1000);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            }).catch(err => {
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            });
        } else if (req.url === '/diff-and-wait' && req.method === 'POST') {
            readJsonBody(req).then(async (body) => {
                const { file1, file2 } = body;
                if (!file1 || !file2) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Both file1 and file2 are required' }));
                    return;
                }

                // Only open diff if the file belongs to the current workspace;
                // otherwise auto-accept without showing the diff.
                if (!isInWorkspace(file2)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ accepted: true, timedOut: false, autoAccepted: true }));
                    return;
                }

                // Open the diff in VS Code. Use a virtual document for the "before" side
                // so the temp snapshot file doesn't pollute VS Code's Ctrl+P / recent files.
                const before = createBeforeDiffUri(file1, file2);
                await vscode.commands.executeCommand('vscode.diff',
                    before.uri,
                    vscode.Uri.file(file2),
                    `${path.basename(file2)} (before) \u2194 ${path.basename(file2)}`
                );

                // Capture the diff tab so we can close it on accept
                const diffTab = vscode.window.tabGroups.activeTabGroup?.activeTab;

                // Navigate the diff view to the first changed line
                try {
                    const diffEditor = vscode.window.activeTextEditor;
                    if (diffEditor) {
                        const firstChange = findFirstChangedLine(file1, file2);
                        const doc = diffEditor.document;
                        const line = doc.lineAt(Math.min(firstChange, doc.lineCount - 1));
                        diffEditor.selection = new vscode.Selection(line.range.start, line.range.start);
                        diffEditor.revealRange(line.range, vscode.TextEditorRevealType.InCenter);
                    }
                } catch {}

                // Persistent side-panel decision UI. It does not cover the editor/logs.
                const timeout = (body.timeout || 60) * 1000;
                const result = diffReviewController
                    ? await diffReviewController.ask({ filePath: file2, timeoutMs: timeout })
                    : 'timeout';

                const accepted = result === '\u2705 Accept';
                const rejected = result === '\u274c Reject';
                const timedOut = result === 'timeout';

                // Close the diff tab after an explicit decision (accept or reject).
                // Leave it open on timeout/cancel so the user can still inspect it.
                if ((accepted || rejected) && diffTab) {
                    try { await vscode.window.tabGroups.close(diffTab); } catch {}
                    cleanupBeforeDiffContent(before.id);
                } else {
                    setTimeout(() => cleanupBeforeDiffContent(before.id), 60 * 60 * 1000);
                }

                if (accepted) {
                    // Open the real file and navigate to the first changed line
                    try {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file2));
                        const editor = await vscode.window.showTextDocument(doc);
                        const firstChange = findFirstChangedLine(file1, file2);
                        const line = doc.lineAt(Math.min(firstChange, doc.lineCount - 1));
                        editor.selection = new vscode.Selection(line.range.start, line.range.start);
                        editor.revealRange(line.range, vscode.TextEditorRevealType.InCenter);
                    } catch {}
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    accepted,
                    timedOut
                }));
            }).catch(err => {
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            });
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

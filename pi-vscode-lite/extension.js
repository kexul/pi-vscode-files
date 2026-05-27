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

// Clean stale bridge files (older than 24 hours) on startup.
// Each VS Code window writes its own per-PID file, so there is no
// shared mutable state and therefore no race condition on read-modify-write.
function cleanStaleBridges() {
    try {
        if (!fs.existsSync(BRIDGE_DIR)) return;
        const now = Date.now();
        for (const name of fs.readdirSync(BRIDGE_DIR)) {
            if (!name.endsWith('.json')) continue;
            const filePath = path.join(BRIDGE_DIR, name);
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (now - data.timestamp > 24 * 60 * 60 * 1000) {
                    fs.unlinkSync(filePath);
                }
            } catch {
                // Corrupt file, remove it
                try { fs.unlinkSync(filePath); } catch {}
            }
        }
    } catch {
        // Silently ignore cleanup errors
    }
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
        fs.writeFileSync(tmpFile, JSON.stringify({
            url,
            token,
            pid: PID,
            timestamp: Date.now()
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
        if (req.url === '/open-editors' && req.method === 'GET') {
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
                vscode.commands.executeCommand('vscode.diff',
                    vscode.Uri.file(file1),
                    vscode.Uri.file(file2),
                    `${path.basename(file1)} \u2194 ${path.basename(file2)}`
                );
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

                // Open the diff in VS Code
                await vscode.commands.executeCommand('vscode.diff',
                    vscode.Uri.file(file1),
                    vscode.Uri.file(file2),
                    `${path.basename(file1)} \u2194 ${path.basename(file2)}`
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

                // Show Accept/Reject quick-pick at top (non-blocking, won't auto-dismiss)
                const timeout = (body.timeout || 60) * 1000;
                const result = await Promise.race([
                    vscode.window.showQuickPick(
                        ['\u2705 Accept', '\u274c Reject'],
                        {
                            placeHolder: 'Review the changes and decide',
                            ignoreFocusOut: true,
                        }
                    ),
                    new Promise(resolve => setTimeout(() => resolve(undefined), timeout))
                ]);

                const accepted = result === '\u2705 Accept';

                if (accepted) {
                    // Close diff tab
                    if (diffTab) {
                        try { await vscode.window.tabGroups.close(diffTab); } catch {}
                    }

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
                    timedOut: result === null
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
        
        // Clean stale bridges first, then register this window
        cleanStaleBridges();
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

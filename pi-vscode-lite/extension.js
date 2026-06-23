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

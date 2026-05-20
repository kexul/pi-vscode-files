const vscode = require('vscode');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let server = null;
let token = null;

function getOpenEditors() {
    const seen = new Map();
    
    // Visible editors
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.scheme !== 'file') continue;
        seen.set(editor.document.uri.toString(), {
            filePath: editor.document.uri.fsPath,
            languageId: editor.document.languageId,
            isDirty: editor.document.isDirty,
            isActive: editor === vscode.window.activeTextEditor
        });
    }
    
    // All open documents
    for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme !== 'file') continue;
        if (seen.has(document.uri.toString())) continue;
        seen.set(document.uri.toString(), {
            filePath: document.uri.fsPath,
            languageId: document.languageId,
            isDirty: document.isDirty,
            isActive: vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()
        });
    }
    
    return [...seen.values()];
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

                // Show Accept/Reject dialog (wait up to 5 minutes)
                const timeout = (body.timeout || 300) * 1000;
                const result = await Promise.race([
                    vscode.window.showInformationMessage(
                        'Review the changes and decide:',
                        { modal: false },
                        '\u2705 Accept',
                        '\u274c Reject'
                    ),
                    new Promise(resolve => setTimeout(() => resolve(null), timeout))
                ]);

                const accepted = result === '\u2705 Accept';

                // Auto-close diff tab on accept
                if (accepted && diffTab) {
                    try {
                        await vscode.window.tabGroups.close(diffTab);
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
        
        // Write connection info to a known location
        const piDir = path.join(process.env.USERPROFILE || process.env.HOME, '.pi');
        if (!fs.existsSync(piDir)) {
            fs.mkdirSync(piDir, { recursive: true });
        }
        
        const bridgeFile = path.join(piDir, 'vscode-bridge.json');
        fs.writeFileSync(bridgeFile, JSON.stringify({
            url: `http://127.0.0.1:${port}`,
            token: token,
            pid: process.pid,
            timestamp: Date.now()
        }));
        
        console.log(`Pi VS Code Lite bridge running on port ${port}`);
    });
    
    // Clean up on deactivate
    context.subscriptions.push({
        dispose() {
            if (server) {
                server.close();
                const bridgeFile = path.join(process.env.USERPROFILE || process.env.HOME, '.pi', 'vscode-bridge.json');
                try { fs.unlinkSync(bridgeFile); } catch {}
            }
        }
    });
}

function deactivate() {
    if (server) {
        server.close();
    }
}

module.exports = { activate, deactivate };

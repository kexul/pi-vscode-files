# pi-vscode-lite

A lightweight VS Code extension that provides a bridge for [pi](https://github.com/nicx-next/pi-coding-agent) coding agent to access VS Code's open files.

## Features

- Runs a local HTTP server on an ephemeral port
- Provides API endpoints for querying open editors
- Token-based authentication for security
- Writes per-window bridge files to `~/.pi/pi-vscode-bridge/{pid}.json` (no race conditions)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/open-editors` | GET | Returns list of open files with metadata |
| `/workspace-folders` | GET | Returns list of workspace folder paths |
| `/diff` | POST | Open VS Code diff editor comparing two files |
| `/diff-and-wait` | POST | Open diff and wait for accept/reject decision |

### Open Editors Response

```json
[
  {
    "filePath": "/path/to/file.ts",
    "languageId": "typescript",
    "isDirty": false,
    "isActive": true
  }
]
```

### Diff Request

```json
POST /diff
{
  "file1": "/path/to/file1.ts",
  "file2": "/path/to/file2.ts"
}
```

This will open VS Code's built-in diff editor with a side-by-side comparison.

## Usage with pi

This extension is designed to work with [pi-vscode-files](https://github.com/kexul/pi-vscode-files), a pi extension that prioritizes VS Code open files in `@` autocomplete.

1. Install this extension in VS Code
2. Install pi-vscode-files in pi (`~/.pi/agent/extensions/pi-vscode-files/`)
3. When you type `@` in pi, your VS Code open files will appear first

### Diff and Wait (Interactive)

```json
POST /diff-and-wait
{
  "file1": "/path/to/file1.ts",
  "file2": "/path/to/file2.ts",
  "timeout": 300
}
```

Same as `/diff` but **waits for user response**. VS Code will show a notification with **✅ Accept** and **❌ Reject** buttons.

Response:
```json
{ "accepted": true, "timedOut": false }
{ "accepted": false, "timedOut": false }
{ "accepted": false, "timedOut": true }
```

### Calling /diff from pi

```bash
# Read the bridge config
BRIDGE=$(cat ~/.pi/vscode-bridge.json)
URL=$(echo $BRIDGE | python -c "import sys,json; print(json.load(sys.stdin)['url'])")
TOKEN=$(echo $BRIDGE | python -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Open diff in VS Code
curl -X POST "$URL/diff" \
  -H "Content-Type: application/json" \
  -H "X-Token: $TOKEN" \
  -d '{"file1": "/path/to/old.ts", "file2": "/path/to/new.ts"}'

## Installation

### From VSIX

```bash
code --install-extension pi-vscode-lite-0.0.1.vsix
```

### Manual

1. Copy the extension folder to `~/.vscode/extensions/pi-vscode-lite/`
2. Restart VS Code

## Security

- Server only listens on `127.0.0.1` (localhost)
- All requests require a random token generated on activation
- Each window writes its own bridge file in `~/.pi/pi-vscode-bridge/{pid}.json`

## License

MIT

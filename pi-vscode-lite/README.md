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
| `/health` | GET | Returns bridge health status |
| `/open-editors` | GET | Returns list of open files with metadata |
| `/workspace-folders` | GET | Returns list of workspace folder paths |

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

## Usage with pi

This extension is designed to work with [pi-vscode-files](https://github.com/kexul/pi-vscode-files), a pi extension that prioritizes VS Code open files in `@` autocomplete.

1. Install this extension in VS Code
2. Install pi-vscode-files in pi (`~/.pi/agent/extensions/pi-vscode-files/`)
3. When you type `@` in pi, your VS Code open files will appear first

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

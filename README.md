# pi-vscode-files

A [pi](https://github.com/nicx-next/pi-coding-agent) extension that prioritizes VS Code open files in `@` autocomplete.

When you type `@xxx` in pi's editor, files currently open in VS Code will appear at the top of suggestions, making it faster to reference files you're actively working on.

## Features

- 📂 Shows VS Code open files at the top of `@` autocomplete suggestions
- ⭐ Active file appears first
- ● Dirty (unsaved) files are prioritized
- 🔍 Fuzzy matching support
- Merges with pi's default file suggestions

## Requirements

- [pi](https://github.com/nicx-next/pi-coding-agent) coding agent
- [pi-vscode-lite](https://marketplace.visualstudio.com/items?itemName=nicx.pi-vscode-lite) VS Code extension (provides the bridge)

## Installation

1. Install the VS Code extension `pi-vscode-lite`
2. Copy this extension to `~/.pi/agent/extensions/pi-vscode-files/`
3. Restart pi

## Commands

| Command | Description |
|---------|-------------|
| `/vscode-files` | Show list of VS Code open files |
| `/vscode-status` | Check VS Code bridge connection status |

## How it works

1. The `pi-vscode-lite` VS Code extension runs a local HTTP server and writes connection info to `~/.pi/vscode-bridge.json`
2. This pi extension reads the bridge config and queries the server for open editors
3. When you type `@`, it fetches the open file list and prioritizes them in autocomplete

## License

MIT

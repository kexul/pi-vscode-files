# pi-vscode-files

A [pi](https://github.com/nicx-next/pi-coding-agent) extension that prioritizes VS Code open files in `@` autocomplete.

When you type `@xxx` in pi's editor, files currently open in VS Code will appear at the top of suggestions, making it faster to reference files you're actively working on.

## Features

- **@ autocomplete** — VS Code open files appear at the top of `@` suggestions, with active/dirty files prioritized
- **Interactive diff** — automatic VS Code side-by-side diff with Accept/Reject for every `edit` tool change

![screenshot](screenshot.png)

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
| `/vscode-diff <file1> <file2>` | Open diff in VS Code and wait for accept/reject |

## Interactive Diff

When pi uses the `edit` tool to modify files, this extension automatically opens a side-by-side diff in VS Code before applying changes:

- **✅ Accept** — keep the changes and let the agent continue
- **❌ Reject** — restore the original file and stop the agent loop (like pressing Esc), waiting for your next input
- **⏰ Timeout (60s)** — changes are kept by default so you never lose work

The diff opens at the first changed line so you can quickly review what the agent did. No more blind edits — you see every change before it lands.

## How it works

1. The `pi-vscode-lite` VS Code extension runs a local HTTP server and writes connection info to `~/.pi/pi-vscode-bridge/{pid}.json`
2. This pi extension reads the bridge config and queries the server for open editors
3. When you type `@`, it fetches the open file list and prioritizes them in autocomplete

## License

MIT

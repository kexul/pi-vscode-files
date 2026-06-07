# pi-vscode-files

A [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) extension that integrates VS Code with pi, providing @ autocomplete, interactive diffs, and clickable symbols.

> **@ autocomplete** — type `@xxx` and VS Code open files appear first. **Interactive diff** — review and accept/reject every edit in VS Code's side-by-side diff before it applies. **Clickable symbols** — function/class names in AI replies become clickable links that jump to the definition line.

## Features

- **@ autocomplete** — VS Code open files appear at the top of `@` suggestions, with active/dirty files prioritized
![screenshot](screenshot-at.png)

- **Interactive diff** — automatic VS Code side-by-side diff with Accept/Reject for every `edit` tool change
![screenshot](screenshot.png)

- **Clickable symbols** — symbols (functions, classes, etc.) in AI replies become clickable OSC 8 links that open the definition in VS Code. Also makes diff hunk headers clickable and appends jump links after code blocks.

- **$ symbol autocomplete** — type `$` to fuzzy-search indexed symbols from open VS Code files

## Commands

| Command | Description |
|---------|-------------|
| `/vscode-files` | Show VS Code open files |
| `/vscode-status` | Check VS Code bridge status |
| `/vscode-diff <file1> <file2>` | Open diff in VS Code and wait for accept/reject |
| `/symbols-reindex` | Reindex symbols from VS Code open files |
| `/symbols-toggle` | Toggle clickable symbols on/off |
| `/symbols-stats` | Show symbol index stats |

## File Structure

```
pi-vscode-files/
├── index.ts              # Main entry: @ autocomplete, diff review, commands
├── bridge.ts             # Shared VS Code bridge utilities (types, fetch, configs, open editors)
├── clickable-symbols.ts  # Clickable symbols feature (extraction, OSC8 links, $ autocomplete)
├── README.md
├── screenshot-at.png
├── screenshot.png
└── pi-vscode-lite/       # VS Code extension (unchanged)
```

## Installation

1. Install the VS Code extension [pi-vscode-lite](https://github.com/kexul/pi-vscode-files/blob/master/pi-vscode-lite/pi-vscode-lite-0.0.1.vsix)
2. Copy this extension to `~/.pi/agent/extensions/pi-vscode-files/`
3. Restart pi

## License

MIT

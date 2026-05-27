# pi-vscode-files

A [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) extension that brings VS Code open files into `@` autocomplete, and opens interactive diffs for `edit` tool changes.

> **@ autocomplete** — type `@xxx` and VS Code open files appear first. **Interactive diff** — review and accept/reject every edit in VS Code's side-by-side diff before it applies.

## Features

- **@ autocomplete** — VS Code open files appear at the top of `@` suggestions, with active/dirty files prioritized
![screenshot](screenshot-at.png)

- **Interactive diff** — automatic VS Code side-by-side diff with Accept/Reject for every `edit` tool change
![screenshot](screenshot.png)


## Installation

1. Install the VS Code extension [pi-vscode-lite](https://github.com/kexul/pi-vscode-files/blob/master/pi-vscode-lite/pi-vscode-lite-0.0.1.vsix)
2. Copy this extension to `~/.pi/agent/extensions/pi-vscode-files/`
3. Restart pi


## License

MIT

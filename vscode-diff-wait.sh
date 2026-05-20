#!/bin/bash
# vscode-diff-wait
# Usage: vscode-diff-wait <file1> <file2> [timeout_seconds]
#
# Shows a diff in VS Code and waits for Accept/Reject.
# Exit code: 0 = Accepted, 1 = Rejected/Timeout, 2 = Error

set -euo pipefail

FILE1="${1:?Usage: vscode-diff-wait <file1> <file2> [timeout]}"
FILE2="${2:?Usage: vscode-diff-wait <file1> <file2> [timeout]}"
TIMEOUT="${3:-300}"

if [ ! -f "$FILE1" ]; then
    echo "❌ File not found: $FILE1" >&2
    exit 2
fi
if [ ! -f "$FILE2" ]; then
    echo "❌ File not found: $FILE2" >&2
    exit 2
fi

# Use Node.js to read bridge config (avoids bash path escaping issues)
BRIDGE=$(node -e "
const fs=require('fs');
const p=require('path');
const f=p.join(process.env.USERPROFILE,'.pi','vscode-bridge.json');
try {
  const d=JSON.parse(fs.readFileSync(f,'utf8'));
  process.stdout.write(JSON.stringify({url:d.url,token:d.token}));
} catch(e) {
  process.exit(1);
}
" 2>/dev/null) || {
    echo "❌ VS Code bridge not found. Is pi-vscode-lite installed and VS Code running?" >&2
    exit 2
}

URL=$(echo "$BRIDGE" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).url))")
TOKEN=$(echo "$BRIDGE" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")

# Call vs code bridge
RESULT=$(curl -s -X POST "$URL/diff-and-wait" \
    -H "Content-Type: application/json" \
    -H "X-Token: $TOKEN" \
    -d "{\"file1\": \"$FILE1\", \"file2\": \"$FILE2\", \"timeout\": $TIMEOUT}")

# Parse result with node
ACCEPTED=$(echo "$RESULT" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).accepted?'true':'false')}catch{console.log('false')}})" 2>/dev/null || echo "false")

if [ "$ACCEPTED" = "true" ]; then
    exit 0
else
    TIMED_OUT=$(echo "$RESULT" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).timedOut?'true':'false')}catch{console.log('false')}})" 2>/dev/null || echo "false")
    if [ "$TIMED_OUT" = "true" ]; then
        echo "⏰ Timed out waiting for decision" >&2
    else
        echo "❌ Changes rejected" >&2
    fi
    exit 1
fi

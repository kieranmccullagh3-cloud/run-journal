#!/bin/bash
# Installs (or with "uninstall", removes) the twice-daily launchd job for the Strava CSV sync.
# This is a user-level LaunchAgent: no sudo, lives in ~/Library/LaunchAgents.
set -euo pipefail
LABEL="com.run-journal.strava-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

NODE="$(command -v node || true)"
[[ -x "$NODE" ]] || { echo "node not found on PATH"; exit 1; }
[[ -f "$HOME/.config/run-journal/strava.json" ]] || { echo "Run 'node sync/setup.js' first."; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s#__NODE__#$NODE#g" -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" \
  "$REPO/sync/com.run-journal.strava-sync.plist.template" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $LABEL (node: $NODE). Runs daily at 09:15 and 21:15 local time."
echo "Run it now:  launchctl kickstart $DOMAIN/$LABEL"
echo "Log:         tail -n 20 ~/Library/Logs/run-journal-sync.log"

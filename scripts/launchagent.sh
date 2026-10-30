#!/bin/bash
# Runs the PMO Assistant as a macOS background service (LaunchAgent), so it
# keeps running without a terminal or Claude Code open, restarts if it
# crashes, and starts at login. Local only — no cloud, no cost.
#
#   scripts/launchagent.sh install    # create + start
#   scripts/launchagent.sh status
#   scripts/launchagent.sh restart    # after changing .env or code
#   scripts/launchagent.sh uninstall
set -euo pipefail

LABEL="com.pmo-assistant"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

node_bin() {
  # Node 24 from nvm (the version pinned in .nvmrc).
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  local v; v="$(cat "$DIR/.nvmrc")"
  nvm which "$v" 2>/dev/null || { echo "Node $v not found: run 'nvm install $v'" >&2; exit 1; }
}

case "${1:-}" in
  install)
    NODE="$(node_bin)"
    mkdir -p "$DIR/logs" "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file-if-exists=.env</string>
    <string>src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/logs/pmo.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/pmo.err.log</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed and started. Logs: $DIR/logs/pmo.out.log"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL" && echo "Restarted."
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit code" || echo "Not installed."
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Uninstalled."
    ;;
  *)
    echo "usage: $0 install|status|restart|uninstall"; exit 1 ;;
esac

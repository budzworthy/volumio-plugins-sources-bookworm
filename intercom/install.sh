#!/bin/bash

echo "Installing Intercom plugin dependencies..."

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd -P)"
cd "$PLUGIN_DIR"

# Install npm dependencies (ws WebSocket library)
npm install --production

# Fix ownership so the volumio user can write/delete node_modules at uninstall
if [ -d "$PLUGIN_DIR/node_modules" ]; then
  chown -R volumio:volumio "$PLUGIN_DIR/node_modules"
fi

echo "Intercom plugin installation complete."
echo "plugininstallend"

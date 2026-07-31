#!/bin/bash

echo "Uninstalling Intercom plugin..."

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd -P)"

# Fix permissions so Volumio can remove node_modules
if [ -d "$PLUGIN_DIR/node_modules" ]; then
  chown -R volumio:volumio "$PLUGIN_DIR/node_modules" 2>/dev/null
  chmod -R u+w "$PLUGIN_DIR/node_modules" 2>/dev/null
fi

echo "Intercom plugin uninstallation complete."
echo "pluginuninstallend"

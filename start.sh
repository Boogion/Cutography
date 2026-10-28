#!/bin/bash
# PaperStrata: starts the app from source and opens it in your browser.
# Run ./start.sh from a terminal. Needs Python 3.9 or newer. Close the Terminal window to quit.
cd "$(dirname "$0")" || exit 1
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    exec "$py" -m paperstrata "$@"
  fi
done
echo
echo "  Python 3.9 or newer was not found."
echo "  Install it from https://www.python.org/downloads/ and run this script again,"
echo "  (on Linux, your package manager has it too: e.g. sudo apt install python3)."
echo
read -r -p "Press Return to close."

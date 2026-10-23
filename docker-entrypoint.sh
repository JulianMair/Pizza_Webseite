#!/bin/sh
set -e

# Docker legt einen fehlenden Bind Mount Ordner (./data) als root an. Damit die App
# ohne root Rechte laufen kann, werden die Besitzrechte beim Start korrigiert und
# der Prozess anschließend als Benutzer "node" gestartet.
if [ "$(id -u)" = "0" ]; then
  DATA="${DATA_DIR:-/app/data}"
  mkdir -p "$DATA"
  chown -R node:node "$DATA"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"

#!/usr/bin/env bash
# Push edited layouts to the car over SSH, without reinstalling the app.
#
#   ./scripts/deploy.sh root@<car-ip-or-hostname> [layout.json ...]
#   APP=cluster_themes ./scripts/deploy.sh root@<car> gt3.json      (the cluster app; default: HUD Widgets)
#
# With no files it pushes the app's built-in layouts from apps/<app>/hud/layouts/.
# They land in the app's data folder, <app>/data/layouts/, where a file overrides the
# built-in layout of the same name (layouts.js). The running app watches that folder and
# redraws the HUD by itself. Delete a file there to go back to the built-in layout.
#
# The app's folder is found on the car, not assumed: OAP installs each app under
# /var/opt/public/oap/oap_<uid>/, and its source/package.json names the app.
# UNVERIFIED until the first install: that path pattern (it comes from
# cauliflowermossgrape/idrive7-apps' docs) and SSH access as root.
set -euo pipefail

APP_ID="${APP:-eva_hud}"
OAP_ROOT="/var/opt/public/oap"

usage() {
    echo "Usage: $(basename "$0") <car-ssh-host> [layout.json ...]" >&2
    echo "  e.g.: $(basename "$0") root@10.0.0.42 my-sport.json" >&2
    exit 1
}

[ $# -ge 1 ] || usage
CAR_HOST="$1"; shift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAYOUT_DIR="$(dirname "$SCRIPT_DIR")/apps/${APP_ID}/hud/layouts"
if [ $# -eq 0 ]; then set -- "$LAYOUT_DIR"/*.json; fi

# Check each file locally first: valid JSON, so the car never gets a file it would refuse.
for f in "$@"; do
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f" || { echo "Not valid JSON: $f" >&2; exit 1; }
done

APP_DIR="$(ssh "$CAR_HOST" "grep -l '\"name\": \"${APP_ID}\"' ${OAP_ROOT}/oap_*/source/package.json 2>/dev/null | head -1 | sed 's#/source/package.json##'")"
if [ -z "$APP_DIR" ]; then
    echo "Could not find ${APP_ID} under ${OAP_ROOT} on ${CAR_HOST}. Is the app installed?" >&2
    exit 1
fi
DEST="${APP_DIR}/data/layouts"
echo "App folder on the car: ${APP_DIR}"

# The data folder belongs to the app's own user: create layouts/ as that user's files.
OWNER="$(ssh "$CAR_HOST" "stat -c '%u:%g' '${APP_DIR}/data'")"
ssh "$CAR_HOST" "mkdir -p '${DEST}' && chown '${OWNER}' '${DEST}'"
scp "$@" "${CAR_HOST}:${DEST}/"
ssh "$CAR_HOST" "chown '${OWNER}' '${DEST}'/*.json"

echo "Pushed $# layout file(s) to ${DEST}. The app reloads them by itself; its status row on"
echo "the center screen says if a layout was refused and why."

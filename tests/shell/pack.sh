#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
out=${1:-$root/dist}
mkdir -p "$out"

extra=()
for file in "$root"/src/*.js; do
    name=$(basename "$file")
    case $name in
        extension.js | prefs.js) ;;
        *) extra+=("--extra-source=$name") ;;
    esac
done

gnome-extensions pack --force --out-dir "$out" "${extra[@]}" "$root/src" >&2
echo "$out/omp-usage@ymkthr.github.io.shell-extension.zip"

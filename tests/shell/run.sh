#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
out=${OMP_USAGE_TEST_OUT:-$root/tests/out}
fixtures=$root/tests/fixtures
mkdir -p "$out"

zip=$("$root/tests/shell/pack.sh" "$out")

scenarios=("$@")
[[ ${#scenarios[@]} -eq 0 ]] && scenarios=(success fail-stale disable-midfetch prefs)

problems='oh-my-usage test: FAIL|Script failed|JS ERROR|already disposed|(Gjs|GLib|GLib-GObject|GLib-GIO|St|Clutter)-CRITICAL'
noise='gnome-shell-perf-helper'

# The Shell's own status items log CRITICALs while the session tears down
# after the script returns, so only the lines up to the done marker count.
until_done() {
    sed '/oh-my-usage test: done/q' "$1"
}

status=0
for scenario in "${scenarios[@]}"; do
    case $scenario in
        success)
            env_args=(OMP_USAGE_TEST_MODE=success
                OMP_USAGE_TEST_OMP="$fixtures/fake-omp"
                OMP_USAGE_TEST_EXPECT_PANEL='^5h 5% · 7d 12%$'
                OMP_USAGE_TEST_EXPECT_MENU='^OpenAI Codex · plus$'
                OMP_USAGE_TEST_EXPECT_ALERT='⚠ Go 1mo 93% +1'
                OMP_USAGE_TEST_EXPECT_ALERT_ROWS='["OpenCode Go · Monthly","OpenAI Codex · plus · 7 days"]') ;;
        fail-stale | disable-midfetch | prefs)
            env_args=(OMP_USAGE_TEST_MODE="$scenario"
                OMP_USAGE_TEST_OMP="$fixtures/fake-omp"
                OMP_USAGE_TEST_EXPECT_PANEL='^5h 5% · 7d 12%$') ;;
        real)
            env_args=(OMP_USAGE_TEST_MODE=success
                OMP_USAGE_TEST_EXPECT_PANEL='^5h [0-9]+% · 7d [0-9]+%$') ;;
        *)
            echo "unknown scenario: $scenario" >&2
            exit 2 ;;
    esac

    log=$out/$scenario.log
    echo "== $scenario"
    if env "${env_args[@]}" OMP_USAGE_TEST_SHOT="$out/$scenario.png" \
        timeout 180 dbus-run-session -- gnome-shell-test-tool --headless --disable-animations \
            --extension "$zip" "$root/tests/shell/screenshot.js" >"$log" 2>&1 \
        && grep -q 'oh-my-usage test: done' "$log" \
        && ! until_done "$log" | grep -E "$problems" | grep -qv "$noise"; then
        grep -E 'oh-my-usage test:' "$log" | sed 's/^.*oh-my-usage test: /   /'
        echo "   PASS"
    else
        until_done "$log" | grep -E "oh-my-usage test:|$problems" | grep -v "$noise" | sed 's/^/   /' || true
        echo "   FAIL  (see $log)"
        status=1
    fi
    pkill -f "$fixtures/fake-omp" || true
done
exit $status

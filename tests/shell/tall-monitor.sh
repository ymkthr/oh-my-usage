#!/usr/bin/env bash
# gnome-shell-test-tool hard-codes a 1280x720 virtual monitor and only lets a
# --wrap command rewrite the gnome-shell argv.
args=()
for arg; do
    [[ $arg == 1280x720 ]] && arg=${OMP_USAGE_TEST_MONITOR:-1280x1200}
    args+=("$arg")
done
exec "${args[@]}"

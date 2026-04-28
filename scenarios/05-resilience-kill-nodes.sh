#!/usr/bin/env bash
#
# Scenario 05 - Resilience.
#
# Hard-kill 5 random trader containers. Gossip continues from the rest;
# antibodies still propagate; the dashboard shows agents-online drop, then
# either (a) the killed containers restart automatically (compose's
# restart=unless-stopped) or (b) the operator brings them back manually.
#
# Narrative beat: "We can take 5 random agents off the network and
# everything else keeps working. There is no central node to take down."
#
# Argument: optional integer for how many to kill (default 5, max 10).
set -euo pipefail
N="${1:-5}"
if ! [[ "$N" =~ ^[0-9]+$ ]] || [ "$N" -gt 10 ]; then
  echo "usage: $0 [N≤10]" >&2
  exit 1
fi

VICTIMS=$(docker ps --filter "name=immunity-demo-trader-" --format "{{.Names}}" | shuf | head -"$N")
if [ -z "$VICTIMS" ]; then
  echo "no trader containers running." >&2
  exit 1
fi

echo "killing $N trader containers:"
echo "$VICTIMS" | sed 's/^/  /'
echo "$VICTIMS" | xargs -r docker kill
echo
echo "Network continues. Restart policy will bring them back within ~60s."

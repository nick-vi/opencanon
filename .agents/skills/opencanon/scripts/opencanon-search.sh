#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 0 ]; then
  echo "usage: $0 <query>" >&2
  exit 2
fi
opencanon search "$*"

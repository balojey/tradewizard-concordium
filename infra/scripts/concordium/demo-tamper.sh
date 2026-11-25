#!/usr/bin/env bash
#
# One command for the demo's tamper beat.
#
#   ./scripts/concordium/demo-tamper.sh <decision-id>
#
# First run edits the decision so its epoch no longer rebuilds (the portal shows
# the 409). Second run puts the original text back. Reads .env.dev for the
# deployment and looks the database host up itself, so nothing has to be exported
# on camera.
set -euo pipefail

cd "$(dirname "$0")/../.."   # infra/

if [[ ! -f .env.dev ]]; then
  echo "No infra/.env.dev found." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.dev
set +a

export DB_SECRET_ARN="${DB_SECRET_ARN:-tw-dev-concordium-db-credentials}"

if [[ -z "${DB_HOST:-}" ]]; then
  DB_HOST="$(aws rds describe-db-instances \
    --db-instance-identifier tw-dev-concordium-postgres \
    --region "${AWS_REGION:-us-east-1}" \
    --query "DBInstances[0].Endpoint.Address" --output text)"
  export DB_HOST
fi

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <decision-id>" >&2
  exit 1
fi

npx tsx scripts/concordium/anchor-proof.ts perturb --decision "$1" --toggle

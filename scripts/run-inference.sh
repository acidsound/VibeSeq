#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_ROOT="$PROJECT_ROOT/server"

env_file_args=()
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  # Let python-dotenv parse data. Sourcing this file would execute shell syntax.
  env_file_args=(--env-file "$PROJECT_ROOT/.env")
fi

sync_args=(sync --project "$SERVER_ROOT" --inexact)
if [[ "${VIBESEQ_INSTALL_MODELS:-0}" == "1" ]]; then
  sync_args+=(--extra models)
fi
uv "${sync_args[@]}"

exec uv run --project "$SERVER_ROOT" uvicorn vibeseq_inference.app:app \
  "${env_file_args[@]}" \
  --host "${VIBESEQ_HOST:-127.0.0.1}" \
  --port "${VIBESEQ_PORT:-8787}" \
  "$@"

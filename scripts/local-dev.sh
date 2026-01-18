#!/bin/bash
set -euo pipefail

# Start local development environment
# Usage: ./scripts/local-dev.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Export environment variables for local dev
export ENVIRONMENT=dev

# Database configuration
# For remote DB via SSM tunnel: set AURORA_SECRET_ARN and AURORA_PORT=5433
# For local Postgres: use DB_* variables below
if [ -n "${AURORA_SECRET_ARN:-}" ]; then
    # Remote DB mode - credentials from AWS Secrets Manager
    export AURORA_HOST="${AURORA_HOST:-localhost}"
    export AURORA_PORT="${AURORA_PORT:-5433}"
    export AURORA_DATABASE="${AURORA_DATABASE:-envoy}"
    echo "    Using remote DB via tunnel (port $AURORA_PORT)"
else
    # Local Postgres mode
    export DB_PROXY_ENDPOINT=localhost
    export DB_PORT="${DB_PORT:-5432}"
    export DB_NAME=envoy
    export DB_USER=envoy_app
    export DB_PASSWORD=localdev
    echo "    Using local Postgres (port $DB_PORT)"
fi

export JWT_PUBLIC_KEY=""
export JWT_ISSUER="http://localhost"
export API_BASE_URL="http://localhost:8000"

# Add shared layer to Python path (NOT layers/shared/python which has Lambda-compiled packages)
export PYTHONPATH="$PROJECT_DIR/layers/shared:$PROJECT_DIR/functions/api:${PYTHONPATH:-}"

echo "==> Starting local development server"
echo "    API will be available at http://localhost:8000"
echo ""

# Run FastAPI with uvicorn
cd "$PROJECT_DIR/functions/api"
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

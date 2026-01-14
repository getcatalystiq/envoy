#!/bin/bash
set -euo pipefail

# Start local development environment
# Usage: ./scripts/local-dev.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Export environment variables for local dev
export ENVIRONMENT=dev
export DB_PROXY_ENDPOINT=localhost
export DB_PORT=5432
export DB_NAME=envoy
export DB_USER=envoy_app
export DB_PASSWORD=localdev
export JWT_PUBLIC_KEY=""
export JWT_ISSUER="http://localhost"
export MAVEN_AGENT_URL="http://localhost:8001/api/agent"
export MAVEN_SERVICE_JWT_SECRET_ARN=""

# Add shared layer to Python path (NOT layers/shared/python which has Lambda-compiled packages)
export PYTHONPATH="$PROJECT_DIR/layers/shared:$PROJECT_DIR/functions/api:${PYTHONPATH:-}"

echo "==> Starting local development server"
echo "    API will be available at http://localhost:8000"
echo ""

# Run FastAPI with uvicorn
cd "$PROJECT_DIR/functions/api"
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

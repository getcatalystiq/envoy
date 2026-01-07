#!/bin/bash
set -euo pipefail

# Envoy deployment script
# Usage: ./scripts/deploy.sh [environment]
# Environments: dev (default), staging, prod

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV="${1:-dev}"

cd "$PROJECT_DIR"

echo "==> Deploying Envoy to $ENV environment"

# Validate environment
if [[ ! "$ENV" =~ ^(dev|staging|prod)$ ]]; then
    echo "Error: Invalid environment '$ENV'. Must be dev, staging, or prod."
    exit 1
fi

# Check for required tools
for cmd in sam aws python3; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "Error: $cmd is required but not installed."
        exit 1
    fi
done

# Install shared layer dependencies
echo "==> Installing shared layer dependencies"
if command -v uv &> /dev/null; then
    uv pip install -r layers/shared/requirements.txt --target layers/shared/python/ --quiet
elif command -v pip3 &> /dev/null; then
    pip3 install -r layers/shared/requirements.txt -t layers/shared/python/ --upgrade --quiet
else
    python3 -m pip install -r layers/shared/requirements.txt -t layers/shared/python/ --upgrade --quiet
fi

# Build SAM application
echo "==> Building SAM application"
sam build --parallel

# Deploy based on environment
echo "==> Deploying to AWS ($ENV)"
if [[ "$ENV" == "prod" ]]; then
    # Production requires explicit confirmation
    sam deploy \
        --config-env prod \
        --no-fail-on-empty-changeset
elif [[ "$ENV" == "staging" ]]; then
    sam deploy \
        --config-env staging \
        --no-fail-on-empty-changeset \
        --no-confirm-changeset
else
    # Dev environment - fastest iteration
    sam deploy \
        --no-fail-on-empty-changeset \
        --no-confirm-changeset
fi

echo "==> Deployment complete!"

# Output API endpoint
STACK_NAME="envoy-$ENV"
API_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
    --output text 2>/dev/null || echo "")

if [[ -n "$API_ENDPOINT" ]]; then
    echo ""
    echo "API Endpoint: $API_ENDPOINT"
    echo "Health Check: $API_ENDPOINT/health"
fi

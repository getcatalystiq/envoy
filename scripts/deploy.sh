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

# Copy migrations to Lambda function directory
echo "==> Syncing migrations to Lambda function"
mkdir -p functions/migration/migrations
rsync -av --delete migrations/*.sql functions/migration/migrations/

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

# Resolve secrets from SSM Parameter Store for non-dev environments
SECRET_OVERRIDES=""
if [[ "$ENV" != "dev" ]]; then
    echo "==> Resolving secrets from SSM Parameter Store"
    AP_API_KEY=$(aws ssm get-parameter --name "/envoy/${ENV}/agentplane-api-key" --with-decryption --query 'Parameter.Value' --output text 2>/dev/null || echo "")
    AP_ADMIN_KEY=$(aws ssm get-parameter --name "/envoy/${ENV}/agentplane-admin-key" --with-decryption --query 'Parameter.Value' --output text 2>/dev/null || echo "")

    if [[ -z "$AP_API_KEY" || -z "$AP_ADMIN_KEY" ]]; then
        echo "Error: Could not resolve AgentPlane secrets from SSM."
        echo "Store them with:"
        echo "  aws ssm put-parameter --name /envoy/${ENV}/agentplane-api-key --type SecureString --value <key>"
        echo "  aws ssm put-parameter --name /envoy/${ENV}/agentplane-admin-key --type SecureString --value <key>"
        exit 1
    fi

    SECRET_OVERRIDES="AgentPlaneAPIKey=${AP_API_KEY} AgentPlaneAdminKey=${AP_ADMIN_KEY}"
fi

# Deploy based on environment
echo "==> Deploying to AWS ($ENV)"
if [[ "$ENV" == "prod" ]]; then
    sam deploy \
        --config-env prod \
        --no-fail-on-empty-changeset \
        --no-confirm-changeset \
        --parameter-overrides ${SECRET_OVERRIDES}
elif [[ "$ENV" == "staging" ]]; then
    sam deploy \
        --config-env staging \
        --no-fail-on-empty-changeset \
        --no-confirm-changeset \
        --parameter-overrides ${SECRET_OVERRIDES}
else
    # Dev environment - fastest iteration
    sam deploy \
        --no-fail-on-empty-changeset \
        --no-confirm-changeset
fi

echo "==> Backend deployment complete!"

# Get stack outputs for frontend deployment
STACK_NAME="envoy-$ENV"
API_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
    --output text 2>/dev/null || echo "")

S3_BUCKET=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`AdminUIBucketName`].OutputValue' \
    --output text 2>/dev/null || echo "")

CLOUDFRONT_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`AdminUIDistributionId`].OutputValue' \
    --output text 2>/dev/null || echo "")

ADMIN_UI_URL=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`AdminUIUrl`].OutputValue' \
    --output text 2>/dev/null || echo "")

if [[ -n "$API_ENDPOINT" ]]; then
    echo ""
    echo "API Endpoint: $API_ENDPOINT"
    echo "Health Check: $API_ENDPOINT/health"
fi

# Deploy frontend if S3 bucket exists
if [[ -n "$S3_BUCKET" && -d "$PROJECT_DIR/admin-ui" ]]; then
    echo ""
    echo "==> Building and deploying frontend"

    cd "$PROJECT_DIR/admin-ui"

    # Install dependencies if node_modules doesn't exist
    if [[ ! -d "node_modules" ]]; then
        echo "Installing frontend dependencies..."
        npm install
    fi

    # Build with correct API and OAuth URLs
    # API_ENDPOINT is the base URL (using $default stage, no path prefix):
    # - VITE_API_URL points to /api/v1 endpoints
    # - VITE_OAUTH_URL points to root-level OAuth endpoints (/.well-known/*, /oauth/*)
    VITE_API_URL="${API_ENDPOINT}/api/v1" VITE_OAUTH_URL="${API_ENDPOINT}" npm run build

    # Upload to S3
    echo "Uploading to S3 bucket: $S3_BUCKET"
    aws s3 sync dist/ "s3://$S3_BUCKET/" --delete

    # Invalidate CloudFront cache
    if [[ -n "$CLOUDFRONT_ID" ]]; then
        echo "Invalidating CloudFront cache..."
        aws cloudfront create-invalidation \
            --distribution-id "$CLOUDFRONT_ID" \
            --paths "/*" \
            --output text > /dev/null
    fi

    echo "Frontend deployed to: $ADMIN_UI_URL"
    cd "$PROJECT_DIR"
fi

echo ""
echo "==> Deployment complete!"

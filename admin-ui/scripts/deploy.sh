#!/bin/bash
#
# Deploy Envoy Admin UI to S3 + CloudFront
#
# Usage:
#   ./scripts/deploy.sh [environment]
#
# Environments: dev (default), staging, prod
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="envoy-${ENVIRONMENT}"

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Envoy Admin UI - Deployment                      ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Environment: ${YELLOW}${ENVIRONMENT}${NC}"
echo -e "Stack Name:  ${YELLOW}${STACK_NAME}${NC}"
echo -e "Region:      ${YELLOW}${REGION}${NC}"
echo ""

cd "$PROJECT_DIR"

# =============================================================================
# Check prerequisites
# =============================================================================
echo -e "${BLUE}Checking prerequisites...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js not found${NC}"
    exit 1
fi

if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI not found${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Prerequisites OK${NC}"
echo ""

# =============================================================================
# Get CloudFormation outputs
# =============================================================================
echo -e "${BLUE}Fetching stack outputs...${NC}"

get_stack_output() {
    local output_key=$1
    aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue" \
        --output text \
        --region "$REGION" 2>/dev/null || echo ""
}

# Get values from CloudFormation stack
S3_BUCKET=$(get_stack_output "AdminUIBucketName")
CLOUDFRONT_DISTRIBUTION_ID=$(get_stack_output "AdminUIDistributionId")
API_URL=$(get_stack_output "ApiEndpoint")
ADMIN_UI_URL=$(get_stack_output "AdminUIUrl")

if [ -z "$S3_BUCKET" ]; then
    echo -e "${RED}Error: Could not find AdminUIBucketName in stack outputs${NC}"
    echo "Make sure the Envoy backend is deployed: cd .. && ./scripts/deploy.sh ${ENVIRONMENT}"
    exit 1
fi

# Append /api/v1 to the API URL for the frontend
API_URL="${API_URL}/api/v1"

echo -e "  S3 Bucket:    ${GREEN}${S3_BUCKET}${NC}"
echo -e "  CloudFront:   ${GREEN}${CLOUDFRONT_DISTRIBUTION_ID}${NC}"
echo -e "  API URL:      ${GREEN}${API_URL}${NC}"
echo ""

# =============================================================================
# Install dependencies
# =============================================================================
echo -e "${BLUE}Installing dependencies...${NC}"
npm ci --silent
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

# =============================================================================
# Build
# =============================================================================
echo -e "${BLUE}Building application...${NC}"
VITE_API_URL="$API_URL" npm run build
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

# =============================================================================
# Upload to S3
# =============================================================================
echo -e "${BLUE}Uploading to S3...${NC}"

# Upload HTML files - no cache (for SPA routing)
aws s3 sync dist/ "s3://${S3_BUCKET}/" \
    --delete \
    --exclude "*" \
    --include "*.html" \
    --cache-control "no-cache, no-store, must-revalidate" \
    --content-type "text/html"

# Upload JS/CSS files - long cache (hashed filenames)
aws s3 sync dist/ "s3://${S3_BUCKET}/" \
    --exclude "*.html" \
    --include "*.js" \
    --include "*.css" \
    --cache-control "public, max-age=31536000, immutable"

# Upload other assets
aws s3 sync dist/ "s3://${S3_BUCKET}/" \
    --exclude "*.html" \
    --exclude "*.js" \
    --exclude "*.css" \
    --cache-control "public, max-age=86400"

echo -e "${GREEN}✓ Upload complete${NC}"
echo ""

# =============================================================================
# Invalidate CloudFront cache
# =============================================================================
if [ -n "$CLOUDFRONT_DISTRIBUTION_ID" ]; then
    echo -e "${BLUE}Invalidating CloudFront cache...${NC}"
    INVALIDATION_ID=$(aws cloudfront create-invalidation \
        --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
        --paths "/*" \
        --query 'Invalidation.Id' \
        --output text)
    echo -e "${GREEN}✓ Cache invalidation started: ${INVALIDATION_ID}${NC}"
else
    echo -e "${YELLOW}No CloudFront distribution ID, skipping invalidation${NC}"
fi
echo ""

# =============================================================================
# Output URLs
# =============================================================================
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    Deployment Complete!                     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Admin UI URL:${NC}"
echo "  ${ADMIN_UI_URL}"
echo ""
echo -e "${YELLOW}API Endpoint:${NC}"
echo "  ${API_URL}"
echo ""
echo -e "${YELLOW}Note:${NC} CloudFront propagation may take a few minutes."
echo ""

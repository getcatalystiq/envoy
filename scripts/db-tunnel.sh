#!/bin/bash
# Opens a tunnel to Aurora via SSM Session Manager
# Usage: ./scripts/db-tunnel.sh [environment] [local_port]
# Example: ./scripts/db-tunnel.sh dev 5432

set -e

ENV="${1:-dev}"
LOCAL_PORT="${2:-5432}"

echo "Fetching connection details for envoy-${ENV}..."

# Find an online SSM-enabled instance (Maven shared bastion)
BASTION_ID=$(aws ssm describe-instance-information \
  --query "InstanceInformationList[?PingStatus=='Online'].InstanceId | [0]" \
  --output text 2>/dev/null)

if [ -z "$BASTION_ID" ] || [ "$BASTION_ID" = "None" ]; then
  echo "Error: Could not find an online SSM-enabled instance"
  echo "Make sure the Maven bastion host is running."
  exit 1
fi

# Get the Aurora cluster endpoint
AURORA_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name "envoy-${ENV}" \
  --query "Stacks[0].Outputs[?OutputKey=='AuroraClusterEndpoint'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$AURORA_ENDPOINT" ] || [ "$AURORA_ENDPOINT" = "None" ]; then
  echo "Error: Could not find Aurora cluster endpoint for envoy-${ENV}"
  exit 1
fi

echo ""
echo "Opening SSM tunnel to Aurora..."
echo "  Bastion: $BASTION_ID"
echo "  Aurora: $AURORA_ENDPOINT"
echo "  Local port: $LOCAL_PORT"
echo ""
echo "Connect your GUI tool to:"
echo "  Host: localhost"
echo "  Port: $LOCAL_PORT"
echo "  Database: envoy"
echo "  Username: envoy_admin"
echo "  Password: (retrieve from AWS Secrets Manager)"
echo ""
echo "Press Ctrl+C to close the tunnel"
echo ""

aws ssm start-session \
  --target "$BASTION_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$AURORA_ENDPOINT\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"

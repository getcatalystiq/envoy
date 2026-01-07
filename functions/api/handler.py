"""Lambda handler for Envoy API."""

import os

from mangum import Mangum

from app.main import app

# Get the API Gateway stage name for proper path handling
stage = os.environ.get("ENVIRONMENT", "dev")
lambda_handler = Mangum(app, lifespan="off", api_gateway_base_path=f"/{stage}")

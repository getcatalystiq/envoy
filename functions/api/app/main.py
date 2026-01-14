"""FastAPI application for Envoy API."""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.routers import auth, targets, content, campaigns, send, analytics, setup, mcp, webhook_targets, outbox, sequences, design_templates, organization, oauth, target_types, segments

# Rate limiter
limiter = Limiter(key_func=get_remote_address)

# Create FastAPI app
app = FastAPI(
    title="Envoy API",
    description="AI-powered sales and marketing agent API",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# Add rate limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS middleware - restrict to known trusted domains
ALLOWED_ORIGINS = [
    "https://chatgpt.com",
    "https://chat.openai.com",
    "https://platform.openai.com",
    "https://claude.ai",
    "https://d2sves47510usz.cloudfront.net",  # Envoy Admin UI (dev)
    "https://d38beagy3imun6.cloudfront.net",  # Envoy Admin UI (prod)
    "http://localhost:3000",  # Local dev
    "http://localhost:5173",  # Vite dev server
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Handle unexpected exceptions."""
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "healthy"}


@app.get("/")
async def root() -> dict[str, str]:
    """Root endpoint."""
    return {"service": "envoy-api", "version": "0.1.0"}


# Include routers
app.include_router(oauth.router, tags=["oauth"])  # OAuth at root for /.well-known/* and /oauth/*
app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(targets.router, prefix="/api/v1/targets", tags=["targets"])
app.include_router(content.router, prefix="/api/v1/content", tags=["content"])
app.include_router(campaigns.router, prefix="/api/v1/campaigns", tags=["campaigns"])
app.include_router(send.router, prefix="/api/v1/send", tags=["send"])
app.include_router(analytics.router, prefix="/api/v1/analytics", tags=["analytics"])
app.include_router(setup.router, prefix="/api/v1/setup", tags=["setup"])
app.include_router(mcp.router, prefix="/mcp", tags=["mcp"])
app.include_router(webhook_targets.router, tags=["webhook"])
app.include_router(outbox.router, prefix="/api/v1/outbox", tags=["outbox"])
app.include_router(sequences.router, prefix="/api/v1/sequences", tags=["sequences"])
app.include_router(design_templates.router, prefix="/api/v1/design-templates", tags=["design-templates"])
app.include_router(organization.router, prefix="/api/v1/organization", tags=["organization"])
app.include_router(target_types.router, prefix="/api/v1/target-types", tags=["target-types"])
app.include_router(segments.router, prefix="/api/v1/segments", tags=["segments"])

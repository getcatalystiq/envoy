"""Authentication router."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr

from shared.auth import authenticate_user, create_access_token

router = APIRouter()


class LoginRequest(BaseModel):
    """Login request body."""

    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    """Login response body."""

    access_token: str
    token_type: str = "bearer"
    user: dict


class UserInfo(BaseModel):
    """User information."""

    id: str
    email: str
    first_name: str | None
    last_name: str | None
    role: str
    organization_id: str
    org_name: str


@router.post("/login", response_model=LoginResponse)
async def login(request: LoginRequest) -> LoginResponse:
    """Authenticate user and return JWT token."""
    user = await authenticate_user(request.email, request.password)

    if not user:
        raise HTTPException(
            status_code=401,
            detail="Invalid email or password",
        )

    token = create_access_token(
        user_id=user["id"],
        email=user["email"],
        org_id=user["organization_id"],
        role=user["role"],
    )

    return LoginResponse(
        access_token=token,
        user=user,
    )

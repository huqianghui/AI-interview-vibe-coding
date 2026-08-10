"""Auth + user request/response schemas (admin/user JWT system)."""

from pydantic import BaseModel, ConfigDict


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    """Public profile of the current user (`GET /auth/me`)."""

    id: str
    username: str
    email: str
    full_name: str
    role: str
    is_active: bool
    preferred_language: str

    model_config = ConfigDict(from_attributes=True)


class AdminUserResponse(UserResponse):
    """Admin view of a user (adds business_unit)."""

    business_unit: str


class UserUpdate(BaseModel):
    """Admin-editable user fields (partial)."""

    full_name: str | None = None
    email: str | None = None
    role: str | None = None
    is_active: bool | None = None
    preferred_language: str | None = None
    business_unit: str | None = None

from functools import lru_cache
from typing import Optional, Union
from pydantic import model_validator, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    APP_NAME: str = "Automated Student Attendance API"
    ENVIRONMENT: str = "development"
    DEBUG: bool = False

    # Database Configuration
    DATABASE_URL: str = "postgresql+asyncpg://atten_user:atten_password@localhost:5432/atten_db"
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 20
    DB_POOL_PRE_PING: bool = True

    # Security & Access Control Configuration
    ENABLE_SHADOW_AUTHORIZATION: bool = False
    SECRET_KEY: str = "insecure-development-secret-key-change-in-production-min-32-chars-long"
    SHADOW_PSEUDONYM_KEY: Optional[str] = None
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480  # 8 hours

    # CORS Configuration
    CORS_ORIGINS: Union[list[str], str] = ["*"]

    # Domain Policy Configuration (Level 1 / Level 4)
    # Default 7 days, configurable per institutional policy
    ATTENDANCE_CORRECTION_WINDOW_DAYS: int = 7

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, v: Union[list[str], str]) -> list[str]:
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        return v

    @model_validator(mode="after")
    def validate_environment_security(self) -> "Settings":
        env = self.ENVIRONMENT.lower()
        if env in ("staging", "production"):
            if "insecure" in self.SECRET_KEY.lower() or len(self.SECRET_KEY) < 32:
                raise ValueError(
                    f"A secure, non-default SECRET_KEY with minimum 32 characters is required in '{self.ENVIRONMENT}' environment."
                )
            if env == "production" and self.DEBUG:
                raise ValueError("DEBUG mode must be disabled in production environment.")
            if self.ENABLE_SHADOW_AUTHORIZATION:
                if not self.SHADOW_PSEUDONYM_KEY or len(self.SHADOW_PSEUDONYM_KEY) < 32:
                    raise ValueError(
                        f"A dedicated SHADOW_PSEUDONYM_KEY with minimum 32 characters (>=128 bits) is required when ENABLE_SHADOW_AUTHORIZATION is enabled in '{self.ENVIRONMENT}'."
                    )
        return self

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore"
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()

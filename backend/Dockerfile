# ==========================================
# Attendly Backend - Multi-Stage Dockerfile
# ==========================================

# Stage 1: Build & Dependency Resolution
FROM python:3.12-slim AS builder

WORKDIR /build

# Copy pyproject.toml and README
COPY pyproject.toml README.md ./

# Install pip and build dependencies into /install
RUN pip install --no-cache-dir --timeout 100 --retries 5 --upgrade pip setuptools wheel \
    && pip install --no-cache-dir --timeout 100 --retries 5 --prefix=/install .

# Stage 2: Minimal Runtime Container
FROM python:3.12-slim AS runtime

# Install essential runtime system dependencies
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4 \
    && apt-get update && (apt-get install -y --no-install-recommends libglib2.0-0t64 || apt-get install -y --no-install-recommends libglib2.0-0) \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Create dedicated non-root application user and group
RUN groupadd -g 10001 appgroup && \
    useradd -u 10001 -g appgroup -s /sbin/nologin -d /app appuser

WORKDIR /app

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Copy application source, migrations, configuration, and scripts
COPY --chown=appuser:appgroup src/ ./src/
COPY --chown=appuser:appgroup alembic/ ./alembic/
COPY --chown=appuser:appgroup alembic.ini ./
COPY --chown=appuser:appgroup scripts/ ./scripts/
COPY --chown=appuser:appgroup README.md ./

# Create uploads directory with correct permissions
RUN mkdir -p /app/uploads/profile_photos && chown -R appuser:appgroup /app

# Set environment variables for Python execution
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH="/app:/app/src"

# Switch to non-root user
USER appuser:appgroup

# Expose internal API port
EXPOSE 8000

# Native health check
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health/live')" || exit 1

# Default startup command (behind reverse proxy)
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]

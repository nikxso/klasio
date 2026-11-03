#!/usr/bin/env bash
# ==============================================================================
# Attendly - Database Backup Script
# Creates a timestamped, compressed custom-format PostgreSQL backup
# ==============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$(pwd)/backups}"
CONTAINER_NAME="${CONTAINER_NAME:-atten_postgres}"
POSTGRES_USER="${POSTGRES_USER:-atten_user}"
POSTGRES_DB="${POSTGRES_DB:-atten_db}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILENAME="attendly_backup_${POSTGRES_DB}_${TIMESTAMP}.dump"
BACKUP_FILEPATH="${BACKUP_DIR}/${BACKUP_FILENAME}"

echo "[INFO] Starting database backup for database '${POSTGRES_DB}' from container '${CONTAINER_NAME}'..."

# Determine container runner (podman or docker)
if command -v podman &>/dev/null; then
    CONTAINER_BIN="podman"
elif command -v docker &>/dev/null; then
    CONTAINER_BIN="docker"
else
    echo "[ERROR] Neither podman nor docker CLI found in PATH." >&2
    exit 1
fi

# Verify container is running
if ! "$CONTAINER_BIN" ps --filter "name=${CONTAINER_NAME}" --filter "status=running" | grep -q "${CONTAINER_NAME}"; then
    echo "[ERROR] Container '${CONTAINER_NAME}' is not running." >&2
    exit 1
fi

# Execute pg_dump using custom compressed archive format
"$CONTAINER_BIN" exec -i -e PGPASSWORD="${POSTGRES_PASSWORD:-atten_password}" "$CONTAINER_NAME" \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c -b > "$BACKUP_FILEPATH"

# Validate output
if [ ! -s "$BACKUP_FILEPATH" ]; then
    echo "[ERROR] Backup file is empty or was not created: ${BACKUP_FILEPATH}" >&2
    rm -f "$BACKUP_FILEPATH"
    exit 1
fi

# Set restrictive permissions on backup file (owner read/write only)
chmod 600 "$BACKUP_FILEPATH"

FILE_SIZE=$(du -h "$BACKUP_FILEPATH" | cut -f1)
echo "[SUCCESS] Database backup created successfully:"
echo "  File: $BACKUP_FILEPATH"
echo "  Size: $FILE_SIZE"

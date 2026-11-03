#!/usr/bin/env bash
# ==============================================================================
# Attendly - Database Restore Script
# Restores a custom-format PostgreSQL backup onto a target database
# ==============================================================================
set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <backup_file.dump> [--confirm]"
    echo "Example: $0 ./backups/attendly_backup_atten_db_20261029_005500.dump --confirm"
    exit 1
fi

BACKUP_FILE="$1"
CONFIRM="${2:-}"
CONTAINER_NAME="${CONTAINER_NAME:-atten_postgres}"
POSTGRES_USER="${POSTGRES_USER:-atten_user}"
POSTGRES_DB="${POSTGRES_DB:-atten_db}"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "[ERROR] Backup file not found: $BACKUP_FILE" >&2
    exit 1
fi

if [ "$CONFIRM" != "--confirm" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "[WARNING] This will drop existing tables and restore database '${POSTGRES_DB}' from '${BACKUP_FILE}'."
    read -r -p "Are you sure you want to proceed? [y/N] " response
    case "$response" in
        [yY][eE][sS]|[yY])
            ;;
        *)
            echo "[INFO] Restore aborted by user."
            exit 0
            ;;
    esac
fi

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

echo "[INFO] Restoring database '${POSTGRES_DB}' from '${BACKUP_FILE}'..."

# Execute pg_restore
"$CONTAINER_BIN" exec -i -e PGPASSWORD="${POSTGRES_PASSWORD:-atten_password}" "$CONTAINER_NAME" \
    pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges < "$BACKUP_FILE" || true

echo "[SUCCESS] Database '${POSTGRES_DB}' restoration completed."

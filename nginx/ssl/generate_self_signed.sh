#!/usr/bin/env bash
set -euo pipefail

# Generate a self-signed TLS certificate for local staging / LAN testing
SSL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_FILE="${SSL_DIR}/cert.pem"
KEY_FILE="${SSL_DIR}/key.pem"

if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    echo "Staging TLS certificate already exists in ${SSL_DIR}."
    exit 0
fi

echo "Generating self-signed TLS certificate for Attendly staging..."
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -subj "/C=US/ST=Academic/L=College/O=Attendly/OU=Staging/CN=attendly.staging.local"

chmod 600 "$KEY_FILE"
chmod 644 "$CERT_FILE"

echo "TLS certificate successfully generated:"
echo "  Cert: $CERT_FILE"
echo "  Key:  $KEY_FILE"

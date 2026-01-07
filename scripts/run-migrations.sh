#!/bin/bash
set -euo pipefail

# Run database migrations
# Usage: ./scripts/run-migrations.sh [connection_string]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MIGRATIONS_DIR="$PROJECT_DIR/migrations"

# Connection string from argument or environment
DB_URL="${1:-${DATABASE_URL:-}}"

if [[ -z "$DB_URL" ]]; then
    echo "Error: Database connection string required."
    echo "Usage: ./scripts/run-migrations.sh <connection_string>"
    echo "   or: DATABASE_URL=... ./scripts/run-migrations.sh"
    exit 1
fi

echo "==> Running migrations from $MIGRATIONS_DIR"

# Run migrations in order
for migration in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
    filename=$(basename "$migration")
    version="${filename%%_*}"

    echo "  -> Checking migration $filename"

    # Check if already applied (skip 000 which creates the table)
    if [[ "$version" != "000" ]]; then
        applied=$(psql "$DB_URL" -t -c "SELECT 1 FROM schema_migrations WHERE version = '$version'" 2>/dev/null || echo "")
        if [[ -n "$applied" ]]; then
            echo "     Already applied, skipping"
            continue
        fi
    fi

    echo "     Applying..."
    psql "$DB_URL" -f "$migration"
    echo "     Done"
done

echo "==> Migrations complete!"

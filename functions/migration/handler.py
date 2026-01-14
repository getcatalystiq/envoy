"""Lambda handler for database migrations."""

import json
import os
from pathlib import Path

import boto3
import psycopg2


def get_db_credentials():
    """Get database credentials from Secrets Manager."""
    secret_arn = os.environ["AURORA_SECRET_ARN"]
    client = boto3.client("secretsmanager")
    response = client.get_secret_value(SecretId=secret_arn)
    return json.loads(response["SecretString"])


def get_connection():
    """Get database connection."""
    creds = get_db_credentials()
    return psycopg2.connect(
        host=os.environ["AURORA_HOST"],
        port=creds.get("port", 5432),
        database=os.environ["AURORA_DATABASE"],
        user=creds["username"],
        password=creds["password"],
        connect_timeout=10,
    )


def run_migrations(conn) -> list[str]:
    """Run all pending migrations."""
    # In Lambda, migrations are in the same directory as handler
    migrations_dir = Path(__file__).parent / "migrations"
    if not migrations_dir.exists():
        migrations_dir = Path("/var/task/migrations")

    migration_files = sorted(migrations_dir.glob("*.sql"))
    results = []

    for migration_file in migration_files:
        migration_name = migration_file.stem
        sql = migration_file.read_text()

        try:
            with conn.cursor() as cur:
                cur.execute(sql)
            conn.commit()
            results.append(f"Applied: {migration_name}")
        except psycopg2.Error as e:
            conn.rollback()
            error_msg = str(e).lower()
            if "already applied" in error_msg or "already exists" in error_msg:
                results.append(f"Skipped: {migration_name} (already applied)")
            else:
                results.append(f"Error in {migration_name}: {e}")
                raise

    return results


def lambda_handler(event, context):
    """Run database migrations."""
    try:
        conn = get_connection()
        results = run_migrations(conn)
        conn.close()

        return {
            "statusCode": 200,
            "body": json.dumps({
                "status": "success",
                "migrations": results,
            }),
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({
                "status": "error",
                "error": str(e),
            }),
        }

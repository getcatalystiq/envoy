"""Aurora Data API client for Envoy's internal database."""

import json
import logging
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from utils.config import config

logger = logging.getLogger(__name__)

_aurora_client: Optional["AuroraClient"] = None


class AuroraClient:
    """
    Client for Aurora Serverless v2 using the Data API.

    Uses RDS Data API for connection-less database access from Lambda.
    """

    def __init__(
        self,
        cluster_arn: str,
        secret_arn: str,
        database: str,
    ):
        self.cluster_arn = cluster_arn
        self.secret_arn = secret_arn
        self.database = database
        self._client = None

    @property
    def client(self):
        """Lazy-load RDS Data API client."""
        if self._client is None:
            self._client = boto3.client("rds-data", region_name=config.aws_region)
        return self._client

    def execute(
        self,
        sql: str,
        parameters: Optional[list[dict]] = None,
        include_result_metadata: bool = True,
    ) -> dict[str, Any]:
        """
        Execute a SQL statement.

        Args:
            sql: SQL statement with :name placeholders
            parameters: List of parameter dicts with name, value, typeHint
            include_result_metadata: Include column metadata in response

        Returns:
            ExecuteStatement response with records and metadata
        """
        try:
            request = {
                "resourceArn": self.cluster_arn,
                "secretArn": self.secret_arn,
                "database": self.database,
                "sql": sql,
                "includeResultMetadata": include_result_metadata,
            }

            if parameters:
                request["parameters"] = parameters

            logger.debug(f"Executing SQL: {sql[:100]}...")
            response = self.client.execute_statement(**request)
            return response

        except ClientError as e:
            logger.exception(f"Aurora query failed: {e}")
            raise

    def query(
        self,
        sql: str,
        parameters: Optional[list[dict]] = None,
    ) -> list[dict[str, Any]]:
        """
        Execute a query and return results as list of dicts.

        Args:
            sql: SELECT statement
            parameters: Query parameters

        Returns:
            List of row dicts
        """
        response = self.execute(sql, parameters)
        return self._parse_records(response)

    def query_one(
        self,
        sql: str,
        parameters: Optional[list[dict]] = None,
    ) -> Optional[dict[str, Any]]:
        """Execute a query and return first row or None."""
        rows = self.query(sql, parameters)
        return rows[0] if rows else None

    def _parse_records(self, response: dict) -> list[dict[str, Any]]:
        """Parse Data API response into list of dicts."""
        records = response.get("records", [])
        metadata = response.get("columnMetadata", [])

        if not metadata or not records:
            return []

        column_names = [col.get("name", f"col_{i}") for i, col in enumerate(metadata)]
        rows = []

        for record in records:
            row = {}
            for i, field in enumerate(record):
                col_name = column_names[i]
                row[col_name] = self._parse_field(field)
            rows.append(row)

        return rows

    def _parse_field(self, field: dict) -> Any:
        """Parse a Data API field value."""
        if "isNull" in field and field["isNull"]:
            return None
        if "stringValue" in field:
            return field["stringValue"]
        if "longValue" in field:
            return field["longValue"]
        if "doubleValue" in field:
            return field["doubleValue"]
        if "booleanValue" in field:
            return field["booleanValue"]
        if "blobValue" in field:
            return field["blobValue"]
        if "arrayValue" in field:
            return self._parse_array(field["arrayValue"])
        return None

    def _parse_array(self, array_value: dict) -> list:
        """Parse a Data API array value."""
        if "stringValues" in array_value:
            return array_value["stringValues"]
        if "longValues" in array_value:
            return array_value["longValues"]
        if "doubleValues" in array_value:
            return array_value["doubleValues"]
        if "booleanValues" in array_value:
            return array_value["booleanValues"]
        if "arrayValues" in array_value:
            return [self._parse_array(av) for av in array_value["arrayValues"]]
        return []


def get_aurora_client() -> AuroraClient:
    """Get or create Aurora client singleton."""
    global _aurora_client

    if _aurora_client is None:
        if not config.aurora_cluster_arn or not config.aurora_secret_arn:
            raise ValueError("Aurora configuration not set")

        _aurora_client = AuroraClient(
            cluster_arn=config.aurora_cluster_arn,
            secret_arn=config.aurora_secret_arn,
            database=config.aurora_database,
        )

    return _aurora_client


def param(name: str, value: Any, type_hint: Optional[str] = None) -> dict:
    """
    Create a Data API parameter.

    Args:
        name: Parameter name (matches :name in SQL)
        value: Parameter value
        type_hint: Optional type hint (UUID, JSON, TIMESTAMP, etc.)

    Returns:
        Parameter dict for Data API
    """
    p = {"name": name}

    if value is None:
        p["value"] = {"isNull": True}
    elif isinstance(value, bool):
        p["value"] = {"booleanValue": value}
    elif isinstance(value, int):
        p["value"] = {"longValue": value}
    elif isinstance(value, float):
        p["value"] = {"doubleValue": value}
    elif isinstance(value, bytes):
        p["value"] = {"blobValue": value}
    elif isinstance(value, list):
        p["value"] = {"stringValue": json.dumps(value)}
        if type_hint:
            p["typeHint"] = type_hint
    else:
        p["value"] = {"stringValue": str(value)}
        if type_hint:
            p["typeHint"] = type_hint

    return p

"""AWS SES email client with batch support."""

import os
from typing import Any

import boto3
from botocore.exceptions import ClientError


class SESClient:
    """Client for sending emails via AWS SES."""

    def __init__(self, region: str = "us-east-1"):
        self.region = region
        self._ses = boto3.client("ses", region_name=region)
        self._from_email = os.environ.get("SES_FROM_EMAIL", "noreply@envoy.app")

    async def send_email(
        self,
        to_email: str,
        subject: str,
        body_html: str,
        body_text: str | None = None,
        reply_to: str | None = None,
        configuration_set: str | None = None,
    ) -> dict[str, Any]:
        """Send a single email."""
        message: dict[str, Any] = {
            "Subject": {"Data": subject, "Charset": "UTF-8"},
            "Body": {
                "Html": {"Data": body_html, "Charset": "UTF-8"},
            },
        }

        if body_text:
            message["Body"]["Text"] = {"Data": body_text, "Charset": "UTF-8"}

        kwargs: dict[str, Any] = {
            "Source": self._from_email,
            "Destination": {"ToAddresses": [to_email]},
            "Message": message,
        }

        if reply_to:
            kwargs["ReplyToAddresses"] = [reply_to]

        if configuration_set:
            kwargs["ConfigurationSetName"] = configuration_set

        try:
            response = self._ses.send_email(**kwargs)
            return {
                "success": True,
                "message_id": response["MessageId"],
            }
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "Unknown")
            error_message = e.response.get("Error", {}).get("Message", str(e))
            return {
                "success": False,
                "error_code": error_code,
                "error_message": error_message,
            }

    async def send_bulk_emails(
        self,
        emails: list[dict[str, Any]],
        configuration_set: str | None = None,
    ) -> list[dict[str, Any]]:
        """Send bulk emails using SES bulk template API.

        Each email dict should have:
        - to_email: str
        - subject: str
        - body_html: str
        - body_text: str (optional)
        """
        results = []

        # SES bulk sending requires templates, so we batch individual sends
        # For true bulk, create a template first
        for email in emails:
            result = await self.send_email(
                to_email=email["to_email"],
                subject=email["subject"],
                body_html=email["body_html"],
                body_text=email.get("body_text"),
                configuration_set=configuration_set,
            )
            result["to_email"] = email["to_email"]
            results.append(result)

        return results

    def verify_email_identity(self, email: str) -> dict[str, Any]:
        """Request verification for an email address."""
        try:
            self._ses.verify_email_identity(EmailAddress=email)
            return {"success": True, "email": email}
        except ClientError as e:
            return {
                "success": False,
                "error": str(e),
            }

    def get_send_quota(self) -> dict[str, Any]:
        """Get current SES sending quota."""
        try:
            response = self._ses.get_send_quota()
            return {
                "max_24_hour_send": response["Max24HourSend"],
                "max_send_rate": response["MaxSendRate"],
                "sent_last_24_hours": response["SentLast24Hours"],
            }
        except ClientError as e:
            return {"error": str(e)}

"""AWS SES v2 email client with custom headers and domain verification."""

import os
from typing import Any

import boto3
from botocore.exceptions import ClientError


class SESClient:
    """Client for sending emails via AWS SES v2."""

    def __init__(self, region: str = "us-east-1"):
        self.region = region
        self._ses = boto3.client("sesv2", region_name=region)
        self._from_email = os.environ.get("SES_FROM_EMAIL", "noreply@envoy.app")

    async def send_email(
        self,
        to_email: str,
        subject: str,
        body_html: str,
        body_text: str | None = None,
        from_email: str | None = None,
        reply_to: str | None = None,
        configuration_set: str | None = None,
        unsubscribe_url: str | None = None,
    ) -> dict[str, Any]:
        """Send a single email via SES v2.

        Args:
            to_email: Recipient email address
            subject: Email subject
            body_html: HTML body content
            body_text: Plain text body (optional)
            from_email: Sender email (falls back to SES_FROM_EMAIL env var)
            reply_to: Reply-to address (optional)
            configuration_set: SES configuration set name (optional)
            unsubscribe_url: URL for List-Unsubscribe header (optional)
        """
        source = from_email or self._from_email

        body: dict[str, Any] = {
            "Html": {"Data": body_html, "Charset": "UTF-8"},
        }
        if body_text:
            body["Text"] = {"Data": body_text, "Charset": "UTF-8"}

        kwargs: dict[str, Any] = {
            "FromEmailAddress": source,
            "Destination": {"ToAddresses": [to_email]},
            "Content": {
                "Simple": {
                    "Subject": {"Data": subject, "Charset": "UTF-8"},
                    "Body": body,
                }
            },
        }

        if reply_to:
            kwargs["ReplyToAddresses"] = [reply_to]

        if configuration_set:
            kwargs["ConfigurationSetName"] = configuration_set

        # Add List-Unsubscribe headers for Gmail/Yahoo compliance
        if unsubscribe_url:
            kwargs["Headers"] = [
                {"Name": "List-Unsubscribe", "Value": f"<{unsubscribe_url}>"},
                {"Name": "List-Unsubscribe-Post", "Value": "List-Unsubscribe=One-Click"},
            ]

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
        """Send bulk emails.

        Each email dict should have:
        - to_email: str
        - subject: str
        - body_html: str
        - body_text: str (optional)
        - from_email: str (optional)
        """
        results = []

        for email in emails:
            result = await self.send_email(
                to_email=email["to_email"],
                subject=email["subject"],
                body_html=email["body_html"],
                body_text=email.get("body_text"),
                from_email=email.get("from_email"),
                configuration_set=configuration_set,
            )
            result["to_email"] = email["to_email"]
            results.append(result)

        return results

    def verify_domain(self, domain: str) -> dict[str, Any]:
        """Start domain verification in SES, return DKIM tokens for DNS setup.

        Args:
            domain: The domain to verify (e.g., "company.com")

        Returns:
            Dict with dkim_tokens list and verified status
        """
        try:
            response = self._ses.create_email_identity(EmailIdentity=domain)
            return {
                "success": True,
                "dkim_tokens": response.get("DkimAttributes", {}).get("Tokens", []),
                "verified": response.get("VerifiedForSendingStatus", False),
            }
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "Unknown")
            # AlreadyExistsException means domain is already registered
            if error_code == "AlreadyExistsException":
                return self.get_domain_status(domain)
            return {
                "success": False,
                "error_code": error_code,
                "error_message": e.response.get("Error", {}).get("Message", str(e)),
            }

    def get_domain_status(self, domain: str) -> dict[str, Any]:
        """Check domain verification status in SES.

        Args:
            domain: The domain to check

        Returns:
            Dict with dkim_tokens, verified status, and dkim_status
        """
        try:
            response = self._ses.get_email_identity(EmailIdentity=domain)
            return {
                "success": True,
                "verified": response.get("VerifiedForSendingStatus", False),
                "dkim_status": response.get("DkimAttributes", {}).get("Status"),
                "dkim_tokens": response.get("DkimAttributes", {}).get("Tokens", []),
            }
        except ClientError as e:
            return {
                "success": False,
                "error_code": e.response.get("Error", {}).get("Code", "Unknown"),
                "error_message": e.response.get("Error", {}).get("Message", str(e)),
            }

    def get_send_quota(self) -> dict[str, Any]:
        """Get current SES sending quota."""
        try:
            response = self._ses.get_account()
            send_quota = response.get("SendQuota", {})
            return {
                "max_24_hour_send": send_quota.get("Max24HourSend"),
                "max_send_rate": send_quota.get("MaxSendRate"),
                "sent_last_24_hours": send_quota.get("SentLast24Hours"),
            }
        except ClientError as e:
            return {"error": str(e)}

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
        tenant_name: str | None = None,
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
            tenant_name: SES tenant name for multi-tenant isolation (optional)
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

        if tenant_name:
            kwargs["TenantName"] = tenant_name

        # Add List-Unsubscribe headers for Gmail/Yahoo compliance
        if unsubscribe_url:
            kwargs["Content"]["Simple"]["Headers"] = [
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

    def create_configuration_set(self, name: str) -> dict[str, Any]:
        """Create an SES configuration set for tracking email events.

        Args:
            name: Unique name for the configuration set

        Returns:
            Dict with success status
        """
        try:
            self._ses.create_configuration_set(ConfigurationSetName=name)
            return {"success": True, "configuration_set_name": name}
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "Unknown")
            if error_code == "AlreadyExistsException":
                return {"success": True, "configuration_set_name": name, "already_exists": True}
            return {
                "success": False,
                "error_code": error_code,
                "error_message": e.response.get("Error", {}).get("Message", str(e)),
            }

    def add_sns_event_destination(
        self,
        configuration_set_name: str,
        sns_topic_arn: str,
        event_destination_name: str = "sns-events",
    ) -> dict[str, Any]:
        """Add SNS event destination to a configuration set.

        This enables delivery, open, click, bounce, and complaint notifications.

        Args:
            configuration_set_name: Name of the configuration set
            sns_topic_arn: ARN of the SNS topic to receive events
            event_destination_name: Name for this event destination

        Returns:
            Dict with success status
        """
        try:
            self._ses.create_configuration_set_event_destination(
                ConfigurationSetName=configuration_set_name,
                EventDestinationName=event_destination_name,
                EventDestination={
                    "Enabled": True,
                    "MatchingEventTypes": [
                        "SEND",
                        "DELIVERY",
                        "OPEN",
                        "CLICK",
                        "BOUNCE",
                        "COMPLAINT",
                    ],
                    "SnsDestination": {
                        "TopicArn": sns_topic_arn,
                    },
                },
            )
            return {"success": True}
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "Unknown")
            if error_code == "AlreadyExistsException":
                return {"success": True, "already_exists": True}
            return {
                "success": False,
                "error_code": error_code,
                "error_message": e.response.get("Error", {}).get("Message", str(e)),
            }

    def setup_configuration_set_with_sns(
        self,
        name: str,
        sns_topic_arn: str,
    ) -> dict[str, Any]:
        """Create a configuration set and add SNS event destination in one call.

        Args:
            name: Unique name for the configuration set
            sns_topic_arn: ARN of the SNS topic to receive events

        Returns:
            Dict with success status and configuration_set_name
        """
        # Create configuration set
        result = self.create_configuration_set(name)
        if not result.get("success"):
            return result

        # Add SNS event destination
        dest_result = self.add_sns_event_destination(name, sns_topic_arn)
        if not dest_result.get("success"):
            return dest_result

        return {"success": True, "configuration_set_name": name}

    # -------------------------------------------------------------------------
    # Tenant Management
    # -------------------------------------------------------------------------

    def create_tenant(self, tenant_name: str) -> dict[str, Any]:
        """Create an SES tenant for multi-tenant isolation.

        Args:
            tenant_name: Unique name for the tenant (max 64 alphanumeric chars, hyphens, underscores)

        Returns:
            Dict with success status, tenant_name, tenant_id, and tenant_arn
        """
        try:
            response = self._ses.create_tenant(TenantName=tenant_name)
            return {
                "success": True,
                "tenant_name": response.get("TenantName"),
                "tenant_id": response.get("TenantId"),
                "tenant_arn": response.get("TenantArn"),
            }
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "Unknown")
            if error_code == "AlreadyExistsException":
                return {"success": True, "tenant_name": tenant_name, "already_exists": True}
            return {
                "success": False,
                "error_code": error_code,
                "error_message": e.response.get("Error", {}).get("Message", str(e)),
            }

    def get_tenant(self, tenant_name: str) -> dict[str, Any]:
        """Get information about an SES tenant.

        Args:
            tenant_name: Name of the tenant

        Returns:
            Dict with tenant details
        """
        try:
            response = self._ses.get_tenant(TenantName=tenant_name)
            return {
                "success": True,
                "tenant_name": response.get("TenantName"),
                "tenant_id": response.get("TenantId"),
                "tenant_arn": response.get("TenantArn"),
                "sending_status": response.get("SendingStatus"),
            }
        except ClientError as e:
            return {
                "success": False,
                "error_code": e.response.get("Error", {}).get("Code", "Unknown"),
                "error_message": e.response.get("Error", {}).get("Message", str(e)),
            }

    def associate_resource_with_tenant(
        self,
        tenant_name: str,
        resource_arn: str,
    ) -> dict[str, Any]:
        """Associate a resource (identity, configuration set) with a tenant.

        Args:
            tenant_name: Name of the tenant
            resource_arn: ARN of the resource to associate

        Returns:
            Dict with success status
        """
        try:
            self._ses.create_tenant_resource_association(
                TenantName=tenant_name,
                ResourceArn=resource_arn,
            )
            return {"success": True}
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "Unknown")
            if error_code == "AlreadyExistsException":
                return {"success": True, "already_exists": True}
            return {
                "success": False,
                "error_code": error_code,
                "error_message": e.response.get("Error", {}).get("Message", str(e)),
            }

    def get_identity_arn(self, identity: str) -> str:
        """Get the ARN for an email identity (domain or email address).

        Args:
            identity: The email identity (domain or email address)

        Returns:
            The ARN string
        """
        account_id = boto3.client("sts").get_caller_identity()["Account"]
        return f"arn:aws:ses:{self.region}:{account_id}:identity/{identity}"

    def get_configuration_set_arn(self, configuration_set_name: str) -> str:
        """Get the ARN for a configuration set.

        Args:
            configuration_set_name: Name of the configuration set

        Returns:
            The ARN string
        """
        account_id = boto3.client("sts").get_caller_identity()["Account"]
        return f"arn:aws:ses:{self.region}:{account_id}:configuration-set/{configuration_set_name}"

    def setup_tenant(
        self,
        tenant_name: str,
        domain: str,
        configuration_set_name: str,
        sns_topic_arn: str,
    ) -> dict[str, Any]:
        """Set up a complete SES tenant with identity, configuration set, and SNS events.

        This is a convenience method that:
        1. Creates the tenant
        2. Creates the configuration set with SNS event destination
        3. Associates the identity (domain) with the tenant
        4. Associates the configuration set with the tenant

        Args:
            tenant_name: Unique name for the tenant
            domain: Email domain (identity) to associate
            configuration_set_name: Name for the configuration set
            sns_topic_arn: ARN of the SNS topic for event notifications

        Returns:
            Dict with success status and created resource names
        """
        # 1. Create tenant
        tenant_result = self.create_tenant(tenant_name)
        if not tenant_result.get("success"):
            return tenant_result

        # 2. Create configuration set with SNS destination
        config_result = self.setup_configuration_set_with_sns(
            configuration_set_name, sns_topic_arn
        )
        if not config_result.get("success"):
            return config_result

        # 3. Associate identity with tenant
        identity_arn = self.get_identity_arn(domain)
        identity_result = self.associate_resource_with_tenant(tenant_name, identity_arn)
        if not identity_result.get("success"):
            return identity_result

        # 4. Associate configuration set with tenant
        config_arn = self.get_configuration_set_arn(configuration_set_name)
        config_assoc_result = self.associate_resource_with_tenant(tenant_name, config_arn)
        if not config_assoc_result.get("success"):
            return config_assoc_result

        return {
            "success": True,
            "tenant_name": tenant_name,
            "configuration_set_name": configuration_set_name,
            "identity": domain,
        }

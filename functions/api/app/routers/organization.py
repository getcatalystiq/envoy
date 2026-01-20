"""Organization settings router."""

import os
from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.dependencies import CurrentOrg, CurrentUser, DBConnection
from app.schemas import DNSRecord, OrganizationResponse, OrganizationUpdate
from shared.ses_client import SESClient

SES_NOTIFICATION_TOPIC_ARN = os.environ.get("SES_NOTIFICATION_TOPIC_ARN", "")

router = APIRouter()


def format_dns_records(domain: str, tokens: list[str], region: str = "us-east-1") -> list[DNSRecord]:
    """Format all DNS records needed for SES domain verification.

    Returns DKIM CNAMEs, MAIL FROM (MX + SPF), and DMARC records.
    """
    records = []

    # DKIM CNAME records
    for token in tokens:
        records.append(
            DNSRecord(
                type="CNAME",
                name=f"{token}._domainkey.{domain}",
                value=f"{token}.dkim.amazonses.com",
            )
        )

    # MAIL FROM MX record (for custom bounce domain)
    mail_from_subdomain = f"mail.{domain}"
    records.append(
        DNSRecord(
            type="MX",
            name=mail_from_subdomain,
            value=f"10 feedback-smtp.{region}.amazonses.com",
        )
    )

    # MAIL FROM SPF record
    records.append(
        DNSRecord(
            type="TXT",
            name=mail_from_subdomain,
            value="v=spf1 include:amazonses.com ~all",
        )
    )

    # DMARC record
    records.append(
        DNSRecord(
            type="TXT",
            name=f"_dmarc.{domain}",
            value="v=DMARC1; p=none; rua=mailto:dmarc@{domain}".replace("{domain}", domain),
        )
    )

    return records


@router.get("", response_model=OrganizationResponse)
async def get_organization(
    org_id: CurrentOrg,
    db: DBConnection,
) -> OrganizationResponse:
    """Get current organization settings."""
    org = await db.fetchrow(
        """SELECT id, name, email_domain, email_domain_verified,
                  email_domain_dkim_tokens, email_from_name,
                  ses_tenant_name, ses_configuration_set
           FROM organizations WHERE id = $1""",
        org_id,
    )

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    dns_records = []
    if org["email_domain"] and org["email_domain_dkim_tokens"]:
        dns_records = format_dns_records(org["email_domain"], org["email_domain_dkim_tokens"])

    return OrganizationResponse(
        id=org["id"],
        name=org["name"],
        email_domain=org["email_domain"],
        email_domain_verified=org["email_domain_verified"] or False,
        email_from_name=org["email_from_name"],
        ses_tenant_name=org["ses_tenant_name"],
        ses_configuration_set=org["ses_configuration_set"],
        dns_records=dns_records,
    )


@router.patch("", response_model=OrganizationResponse)
async def update_organization(
    data: OrganizationUpdate,
    user: CurrentUser,
    org_id: CurrentOrg,
    db: DBConnection,
) -> OrganizationResponse:
    """Update organization settings including email domain."""
    # Check admin role for domain changes
    if data.email_domain is not None and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required to change email domain")

    updates = []
    params = [org_id]
    param_idx = 2

    if data.email_from_name is not None:
        updates.append(f"email_from_name = ${param_idx}")
        params.append(data.email_from_name)
        param_idx += 1

    if data.email_domain is not None:
        if data.email_domain:
            # Start domain verification with SES
            ses = SESClient()
            result = ses.verify_domain(data.email_domain)

            if not result.get("success", True):
                raise HTTPException(
                    status_code=400,
                    detail=f"Failed to verify domain: {result.get('error_message', 'Unknown error')}",
                )

            updates.append(f"email_domain = ${param_idx}")
            params.append(data.email_domain)
            param_idx += 1

            updates.append(f"email_domain_dkim_tokens = ${param_idx}")
            params.append(result.get("dkim_tokens", []))
            param_idx += 1

            updates.append(f"email_domain_verified = ${param_idx}")
            params.append(result.get("verified", False))
            param_idx += 1
        else:
            # Clear domain
            updates.append(f"email_domain = ${param_idx}")
            params.append(None)
            param_idx += 1

            updates.append(f"email_domain_dkim_tokens = ${param_idx}")
            params.append(None)
            param_idx += 1

            updates.append(f"email_domain_verified = ${param_idx}")
            params.append(False)
            param_idx += 1

    if updates:
        await db.execute(
            f"""UPDATE organizations
                SET {', '.join(updates)}, updated_at = NOW()
                WHERE id = $1""",
            *params,
        )

    return await get_organization(org_id, db)


@router.post("/verify-domain", response_model=OrganizationResponse)
async def verify_domain_status(
    user: CurrentUser,
    org_id: CurrentOrg,
    db: DBConnection,
) -> OrganizationResponse:
    """Check and update domain verification status from SES."""
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    org = await db.fetchrow(
        "SELECT email_domain, ses_tenant_name, ses_configuration_set FROM organizations WHERE id = $1",
        org_id,
    )

    if not org or not org["email_domain"]:
        raise HTTPException(status_code=400, detail="No email domain configured")

    ses = SESClient()
    result = ses.get_domain_status(org["email_domain"])

    if not result.get("success", True):
        raise HTTPException(
            status_code=400,
            detail=f"Failed to check domain status: {result.get('error_message', 'Unknown error')}",
        )

    is_verified = result.get("verified", False)
    tenant_name = org["ses_tenant_name"]
    config_set_name = org["ses_configuration_set"]

    # Create SES tenant with configuration set when domain becomes verified
    if is_verified and not tenant_name and SES_NOTIFICATION_TOPIC_ARN:
        tenant_name = f"envoy-{org_id}"
        config_set_name = f"envoy-{org_id}"

        tenant_result = ses.setup_tenant(
            tenant_name=tenant_name,
            domain=org["email_domain"],
            configuration_set_name=config_set_name,
            sns_topic_arn=SES_NOTIFICATION_TOPIC_ARN,
        )
        if not tenant_result.get("success"):
            # Log but don't fail - domain verification is more important
            print(f"Failed to create SES tenant: {tenant_result.get('error_message')}")
            tenant_name = None
            config_set_name = None

    await db.execute(
        """UPDATE organizations
           SET email_domain_verified = $2,
               email_domain_dkim_tokens = $3,
               ses_tenant_name = COALESCE($4, ses_tenant_name),
               ses_configuration_set = COALESCE($5, ses_configuration_set),
               updated_at = NOW()
           WHERE id = $1""",
        org_id,
        is_verified,
        result.get("dkim_tokens", []),
        tenant_name,
        config_set_name,
    )

    return await get_organization(org_id, db)

"""Setup router for Maven skills provisioning."""

import json
from pathlib import Path

import yaml
from fastapi import APIRouter, HTTPException

from app.dependencies import CurrentOrg, CurrentUser, DBConnection
from shared.maven_client import MavenClient

router = APIRouter()

SKILLS_DIR = Path(__file__).parent.parent.parent / "skills"


def parse_skill_file(path: Path) -> dict:
    """Parse skill markdown file into name, description, prompt."""
    content = path.read_text()

    # Parse YAML frontmatter
    if content.startswith("---"):
        end = content.index("---", 3)
        frontmatter = yaml.safe_load(content[3:end])
        prompt = content[end + 3 :].strip()
    else:
        frontmatter = {}
        prompt = content

    return {
        "slug": frontmatter.get("name", path.stem),
        "name": frontmatter.get("name", path.stem),
        "description": frontmatter.get("description", ""),
        "prompt": prompt,
    }


@router.post("/provision-skills")
async def provision_skills(
    user: CurrentUser,
    org_id: CurrentOrg,
    db: DBConnection,
) -> dict:
    """Provision Maven skills for this organization."""
    # Check admin role
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    # Get maven tenant ID from org
    org = await db.fetchrow(
        "SELECT maven_tenant_id FROM organizations WHERE id = $1",
        org_id,
    )
    if not org or not org["maven_tenant_id"]:
        raise HTTPException(status_code=400, detail="Organization not configured for Maven")

    maven = MavenClient(tenant_id=org["maven_tenant_id"])

    results = []
    for skill_file in SKILLS_DIR.glob("*.md"):
        skill = parse_skill_file(skill_file)
        try:
            await maven.provision_skill(**skill)
            results.append({"skill": skill["slug"], "status": "success"})
        except Exception as e:
            results.append({"skill": skill["slug"], "status": "error", "error": str(e)})

    # Update org record
    await db.execute(
        """UPDATE organizations
           SET maven_skills_provisioned_at = NOW(),
               maven_skills_status = $1
           WHERE id = $2""",
        json.dumps({r["skill"]: r["status"] for r in results}),
        org_id,
    )

    failed = [r for r in results if r["status"] == "error"]
    if failed:
        raise HTTPException(status_code=207, detail={"results": results, "message": "Some skills failed"})

    return {"status": "success", "results": results}


@router.get("/status")
async def get_setup_status(
    org_id: CurrentOrg,
    db: DBConnection,
) -> dict:
    """Get current setup status for organization."""
    org = await db.fetchrow(
        """SELECT maven_tenant_id, maven_skills_provisioned_at, maven_skills_status
           FROM organizations WHERE id = $1""",
        org_id,
    )

    skills_status = None
    if org and org["maven_skills_status"]:
        skills_status = json.loads(org["maven_skills_status"])

    return {
        "maven_configured": bool(org and org["maven_tenant_id"]),
        "skills_provisioned_at": org["maven_skills_provisioned_at"].isoformat() if org and org["maven_skills_provisioned_at"] else None,
        "skills_status": skills_status,
    }

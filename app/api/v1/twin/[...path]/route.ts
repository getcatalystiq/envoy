const PROBLEM_DETAIL = {
  type: "about:blank",
  title: "Gone",
  status: 410,
  detail:
    "The /api/v1/twin/* surface was replaced by /api/v1/agent/* (Claude Managed Agents). See README and CLAUDE.md for migration.",
};

function goneResponse(): Response {
  return new Response(JSON.stringify(PROBLEM_DETAIL), {
    status: 410,
    headers: { "Content-Type": "application/problem+json" },
  });
}

export async function GET() {
  return goneResponse();
}

export async function POST() {
  return goneResponse();
}

export async function PUT() {
  return goneResponse();
}

export async function PATCH() {
  return goneResponse();
}

export async function DELETE() {
  return goneResponse();
}

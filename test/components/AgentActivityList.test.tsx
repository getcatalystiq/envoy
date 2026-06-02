// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn() },
  formatApiError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { api } from "@/lib/api";
import { AgentActivityList } from "@/components/settings/AgentActivityList";

const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("<AgentActivityList />", () => {
  it("renders one row per session, newest first, with status badges", async () => {
    apiGet.mockResolvedValueOnce({
      sessions: [
        { id: "sess_old", status: "terminated", created_at: "2026-06-01T01:00:00Z" },
        { id: "sess_new", status: "idle", created_at: "2026-06-01T05:00:00Z" },
      ],
    });
    render(<AgentActivityList />);
    await screen.findByText("sess_new");
    const links = screen.getAllByRole("link");
    // newest-first: sess_new before sess_old
    expect(links[0].textContent).toContain("sess_new");
    expect(links[1].textContent).toContain("sess_old");
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("terminated")).toBeInTheDocument();
  });

  it("renders an empty state", async () => {
    apiGet.mockResolvedValueOnce({ sessions: [] });
    render(<AgentActivityList />);
    await waitFor(() => expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument());
  });

  it("renders a distinct 'no agent configured' state on a 503 with a config link", async () => {
    apiGet.mockRejectedValueOnce(Object.assign(new Error("unconfigured"), { status: 503 }));
    render(<AgentActivityList />);
    await waitFor(() => expect(screen.getByText(/no agent configured/i)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /configure your agent/i })).toBeInTheDocument();
  });

  it("renders a transient error distinctly from the unconfigured state", async () => {
    apiGet.mockRejectedValueOnce(Object.assign(new Error("upstream boom"), { status: 502 }));
    render(<AgentActivityList />);
    await waitFor(() => expect(screen.getByText(/upstream boom/)).toBeInTheDocument());
    expect(screen.queryByText(/no agent configured/i)).not.toBeInTheDocument();
  });
});

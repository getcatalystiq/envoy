// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn() },
  formatApiError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// next/link needs the App Router runtime — stub it.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { api } from "@/lib/api";
import { TwinRunsList } from "@/components/settings/TwinRunsList";

const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<TwinRunsList />", () => {
  it("renders 'No runs yet' when empty", async () => {
    apiGet.mockResolvedValueOnce({ runs: [], total_runs: 0, page: 1, page_size: 50 });
    render(<TwinRunsList />);
    await waitFor(() => expect(screen.queryByText(/No runs yet/i)).toBeInTheDocument());
  });

  it("renders a row per run with run_number and run_id", async () => {
    apiGet.mockResolvedValueOnce({
      runs: [
        {
          run_id: "run_abc",
          agent_id: "agent-1",
          run_number: 7,
          status: "finished",
          is_finished: true,
          started_at: "2026-05-28T10:00:00Z",
          last_event_at: "2026-05-28T10:01:00Z",
          event_count: 5,
          step_count: 2,
        },
      ],
      total_runs: 1,
      page: 1,
      page_size: 50,
    });
    render(<TwinRunsList />);
    await waitFor(() => expect(screen.queryByText(/#7/)).toBeInTheDocument());
    expect(screen.queryByText(/run_abc/)).toBeInTheDocument();
    expect(screen.queryByText(/5 events/)).toBeInTheDocument();
    expect(screen.queryByText(/finished/)).toBeInTheDocument();
  });

  it("displays in_progress status badge for unfinished runs", async () => {
    apiGet.mockResolvedValueOnce({
      runs: [
        {
          run_id: "r1",
          agent_id: "agent-1",
          run_number: 1,
          is_finished: false,
          started_at: "2026-05-28T10:00:00Z",
          last_event_at: "2026-05-28T10:01:00Z",
          event_count: 1,
          step_count: 0,
        },
      ],
      total_runs: 1,
      page: 1,
      page_size: 50,
    });
    render(<TwinRunsList />);
    await waitFor(() => expect(screen.queryByText(/in_progress/)).toBeInTheDocument());
  });

  it("orders runs newest-first by started_at", async () => {
    const mk = (id: string, n: number, started: string) => ({
      run_id: id, agent_id: "a", run_number: n, status: "finished", is_finished: true,
      started_at: started, last_event_at: started, event_count: 1, step_count: 1,
    });
    apiGet.mockResolvedValueOnce({
      runs: [
        mk("run_old", 1, "2026-05-01T10:00:00Z"),
        mk("run_new", 3, "2026-05-28T10:00:00Z"),
        mk("run_mid", 2, "2026-05-10T10:00:00Z"),
      ],
      total_runs: 3, page: 1, page_size: 50,
    });
    render(<TwinRunsList />);
    await waitFor(() => expect(screen.queryByText(/run_new/)).toBeInTheDocument());
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveTextContent("run_new");
    expect(links[1]).toHaveTextContent("run_mid");
    expect(links[2]).toHaveTextContent("run_old");
  });

  it("fetches the LAST page (newest runs) when results are paginated", async () => {
    apiGet
      .mockResolvedValueOnce({
        // page 1 = oldest; never displayed
        runs: [{ run_id: "run_oldest", agent_id: "a", run_number: 1, is_finished: true, status: "finished", started_at: "2026-01-01T00:00:00Z", last_event_at: "", event_count: 1, step_count: 1 }],
        total_runs: 120, page: 1, page_size: 50,
      })
      .mockResolvedValueOnce({
        runs: [{ run_id: "run_newest", agent_id: "a", run_number: 120, is_finished: true, status: "finished", started_at: "2026-05-28T00:00:00Z", last_event_at: "", event_count: 1, step_count: 1 }],
        total_runs: 120, page: 3, page_size: 50,
      });
    render(<TwinRunsList />);
    await waitFor(() => expect(screen.queryByText(/run_newest/)).toBeInTheDocument());
    // ceil(120/50) = 3 → it must request page 3, and must NOT show the oldest page
    expect(apiGet).toHaveBeenCalledWith("/twin/runs?page=1&page_size=50");
    expect(apiGet).toHaveBeenCalledWith("/twin/runs?page=3&page_size=50");
    expect(screen.queryByText(/run_oldest/)).not.toBeInTheDocument();
  });

  it("displays error message on api.get failure", async () => {
    apiGet.mockRejectedValueOnce(new Error("Network down"));
    render(<TwinRunsList />);
    await waitFor(() => expect(screen.queryByText(/Network down/)).toBeInTheDocument());
  });
});

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

  it("displays error message on api.get failure", async () => {
    apiGet.mockRejectedValueOnce(new Error("Network down"));
    render(<TwinRunsList />);
    await waitFor(() => expect(screen.queryByText(/Network down/)).toBeInTheDocument());
  });
});

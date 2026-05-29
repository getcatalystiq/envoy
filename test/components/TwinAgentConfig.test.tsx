// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
  },
  formatApiError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { api } from "@/lib/api";
import { TwinAgentConfig } from "@/components/settings/TwinAgentConfig";

const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
const apiPatch = api.patch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<TwinAgentConfig />", () => {
  it("shows a loading spinner before the org loads", () => {
    apiGet.mockReturnValue(new Promise(() => {})); // never resolves
    render(<TwinAgentConfig />);
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("loads the agent id and shows env-var fallback when no per-org key", async () => {
    apiGet.mockResolvedValueOnce({
      twin_agent_id: "agent-1",
      twin_api_key_configured: false,
    });
    render(<TwinAgentConfig />);
    const input = (await screen.findByPlaceholderText("agent_xxxxxxxxxxxx")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("agent-1"));
    expect(screen.getByText(/Using TWIN_API_KEY env var/)).toBeInTheDocument();
    // Not-configured → button reads "Set", no "Clear"
    expect(screen.getByRole("button", { name: /^Set$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Clear$/ })).not.toBeInTheDocument();
  });

  it("shows configured state with Replace + Clear when a per-org key exists", async () => {
    apiGet.mockResolvedValueOnce({
      twin_agent_id: "agent-1",
      twin_api_key_configured: true,
    });
    render(<TwinAgentConfig />);
    await screen.findByPlaceholderText("agent_xxxxxxxxxxxx");
    expect(screen.getByText(/configured/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Replace$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Clear$/ })).toBeInTheDocument();
  });

  it("Save is disabled until something changes", async () => {
    apiGet.mockResolvedValueOnce({ twin_agent_id: "agent-1", twin_api_key_configured: false });
    render(<TwinAgentConfig />);
    await screen.findByPlaceholderText("agent_xxxxxxxxxxxx");
    const save = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("saves only the changed agent id (no twin_api_key in payload)", async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValueOnce({ twin_agent_id: "agent-1", twin_api_key_configured: true });
    apiPatch.mockResolvedValueOnce({ twin_agent_id: "agent-2", twin_api_key_configured: true });

    render(<TwinAgentConfig />);
    const input = (await screen.findByPlaceholderText("agent_xxxxxxxxxxxx")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("agent-1"));

    await user.clear(input);
    await user.type(input, "agent-2");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/organization", { twin_agent_id: "agent-2" }),
    );
    // Crucially: payload must NOT carry twin_api_key when the key wasn't edited.
    expect(apiPatch.mock.calls[0][1]).not.toHaveProperty("twin_api_key");
  });

  it("trims to null when the agent id is cleared", async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValueOnce({ twin_agent_id: "agent-1", twin_api_key_configured: false });
    apiPatch.mockResolvedValueOnce({ twin_agent_id: null, twin_api_key_configured: false });

    render(<TwinAgentConfig />);
    const input = (await screen.findByPlaceholderText("agent_xxxxxxxxxxxx")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("agent-1"));

    await user.clear(input);
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/organization", { twin_agent_id: null }),
    );
  });

  it("Set → enter key → Save sends only twin_api_key", async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValueOnce({ twin_agent_id: "agent-1", twin_api_key_configured: false });
    apiPatch.mockResolvedValueOnce({ twin_agent_id: "agent-1", twin_api_key_configured: true });

    render(<TwinAgentConfig />);
    await screen.findByPlaceholderText("agent_xxxxxxxxxxxx");

    await user.click(screen.getByRole("button", { name: /^Set$/ }));
    const keyInput = (await screen.findByPlaceholderText("tw_live_...")) as HTMLInputElement;
    expect(keyInput.type).toBe("password"); // secret is masked
    await user.type(keyInput, "tw_live_secret");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/organization", { twin_api_key: "tw_live_secret" }),
    );
    expect(apiPatch.mock.calls[0][1]).not.toHaveProperty("twin_agent_id");
  });

  it("Clear unconfigures the per-org key (PATCH twin_api_key: null)", async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValueOnce({ twin_agent_id: "agent-1", twin_api_key_configured: true });
    apiPatch.mockResolvedValueOnce({ twin_agent_id: "agent-1", twin_api_key_configured: false });

    render(<TwinAgentConfig />);
    await screen.findByPlaceholderText("agent_xxxxxxxxxxxx");

    await user.click(screen.getByRole("button", { name: /^Clear$/ }));

    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/organization", { twin_api_key: null }),
    );
  });

  it("shows an error when the org fails to load", async () => {
    apiGet.mockRejectedValueOnce(new Error("boom"));
    render(<TwinAgentConfig />);
    await waitFor(() => expect(screen.queryByText(/boom/)).toBeInTheDocument());
  });
});

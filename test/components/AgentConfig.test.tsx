// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), patch: vi.fn() },
  formatApiError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { api } from "@/lib/api";
import { AgentConfig } from "@/components/settings/AgentConfig";

const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
const apiPatch = api.patch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("<AgentConfig />", () => {
  it("shows a loading spinner before the org loads", () => {
    apiGet.mockReturnValue(new Promise(() => {}));
    render(<AgentConfig />);
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("loads agent_id + environment_id and renders no secret/password field", async () => {
    apiGet.mockResolvedValueOnce({ agent_id: "agent-1", environment_id: "env-1" });
    render(<AgentConfig />);
    const agentInput = (await screen.findByPlaceholderText(
      "agent_xxxxxxxxxxxx",
    )) as HTMLInputElement;
    const envInput = screen.getByPlaceholderText("env_xxxxxxxxxxxx") as HTMLInputElement;
    await waitFor(() => expect(agentInput.value).toBe("agent-1"));
    expect(envInput.value).toBe("env-1");
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("Save is disabled until something changes", async () => {
    apiGet.mockResolvedValueOnce({ agent_id: "agent-1", environment_id: "env-1" });
    render(<AgentConfig />);
    await screen.findByPlaceholderText("agent_xxxxxxxxxxxx");
    const save = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("saves only the changed agent id", async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValueOnce({ agent_id: "agent-1", environment_id: "env-1" });
    apiPatch.mockResolvedValueOnce({ agent_id: "agent-2", environment_id: "env-1" });
    render(<AgentConfig />);
    const input = (await screen.findByPlaceholderText(
      "agent_xxxxxxxxxxxx",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("agent-1"));
    await user.clear(input);
    await user.type(input, "agent-2");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/organization", { agent_id: "agent-2" }),
    );
    expect(apiPatch.mock.calls[0][1]).not.toHaveProperty("environment_id");
  });

  it("clears agent id to null", async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValueOnce({ agent_id: "agent-1", environment_id: "" });
    apiPatch.mockResolvedValueOnce({ agent_id: null, environment_id: "" });
    render(<AgentConfig />);
    const input = (await screen.findByPlaceholderText(
      "agent_xxxxxxxxxxxx",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("agent-1"));
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/organization", { agent_id: null }),
    );
  });

  it("shows the 'already in use' message on a 409", async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValueOnce({ agent_id: "agent-1", environment_id: "env-1" });
    apiPatch.mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409 }));
    render(<AgentConfig />);
    const input = (await screen.findByPlaceholderText(
      "agent_xxxxxxxxxxxx",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("agent-1"));
    await user.clear(input);
    await user.type(input, "agent-taken");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(screen.getByText(/already in use by another organization/i)).toBeInTheDocument(),
    );
  });

  it("shows a retry on load failure", async () => {
    apiGet.mockRejectedValueOnce(new Error("boom"));
    render(<AgentConfig />);
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

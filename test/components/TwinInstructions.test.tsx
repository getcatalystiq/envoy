// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
  },
  formatApiError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { api } from "@/lib/api";
import { TwinInstructions } from "@/components/settings/TwinInstructions";

const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;
const apiPut = api.put as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<TwinInstructions />", () => {
  it("shows loading indicator initially", () => {
    apiGet.mockReturnValue(new Promise(() => {})); // never resolves
    render(<TwinInstructions />);
    // Loader2 from lucide renders an svg with role
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("loads instructions content into textarea", async () => {
    apiGet.mockResolvedValueOnce({ instructions: { content: "Hello world" } });
    render(<TwinInstructions />);
    const textarea = (await screen.findByPlaceholderText(/Describe what your agent/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("Hello world"));
  });

  it("renders empty string when no instructions yet", async () => {
    apiGet.mockResolvedValueOnce({ instructions: null });
    render(<TwinInstructions />);
    const textarea = (await screen.findByPlaceholderText(/Describe what your agent/i)) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });

  it("displays error from api.get failure", async () => {
    apiGet.mockRejectedValueOnce(new Error("Twin down"));
    render(<TwinInstructions />);
    await waitFor(() => expect(screen.queryByText(/Twin down/)).toBeInTheDocument());
  });

  it("saves edited content via api.put on Save button click", async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValueOnce({ instructions: { content: "Old" } });
    apiPut.mockResolvedValueOnce({ success: true });

    render(<TwinInstructions />);
    const textarea = (await screen.findByPlaceholderText(/Describe what your agent/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("Old"));

    await user.clear(textarea);
    await user.type(textarea, "New behavior");

    const save = screen.getByRole("button", { name: /save/i });
    await user.click(save);

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith("/twin/instructions", {
        content: "New behavior",
      }),
    );
  });

  it("disables Save when nothing has changed", async () => {
    apiGet.mockResolvedValueOnce({ instructions: { content: "stable" } });
    render(<TwinInstructions />);
    await screen.findByPlaceholderText(/Describe what your agent/i);
    const save = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});

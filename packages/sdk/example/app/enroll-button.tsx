"use client";

import { useState } from "react";

// A minimal client form that POSTs to the host's /api/enroll route. The admin token is sent
// from the browser only because this is a dev-only dogfood harness; a real host would enroll
// server-side off its own product event, never expose an admin token to the client.
export function EnrollButton() {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  async function onEnroll() {
    setStatus("enrolling…");
    try {
      const res = await fetch("/api/enroll", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.NEXT_PUBLIC_EXAMPLE_ADMIN_TOKEN ?? ""}`,
        },
        body: JSON.stringify({ email, firstName, plan: "pro" }),
      });
      const body = (await res.json()) as { created?: boolean; suppressed?: boolean };
      setStatus(
        res.ok
          ? `ok — created=${String(body.created)} suppressed=${String(body.suppressed)}`
          : `error ${res.status}`,
      );
    } catch (err) {
      setStatus(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <input
        placeholder="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        placeholder="first name"
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
      />
      <button type="button" onClick={onEnroll} disabled={email.length === 0}>
        Enroll into welcome drip
      </button>
      {status && <p>{status}</p>}
    </div>
  );
}

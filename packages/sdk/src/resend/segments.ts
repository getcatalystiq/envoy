import "server-only";

// Segment membership helpers (U7 / origin R10, R17, R37). Resend Segments are STATIC lists (no rule
// engine) — eligibility is host-computed and reflected as EXPLICIT membership (R37). Every enrolled
// contact joins the install's base Segment so the broadcast lane can target it (R10/R17).
//
// These are thin, fail-soft wrappers over `resend.contacts.segments.{add,remove}`. They never throw
// on a Resend-reported error or transport failure; they return a structured `{ ok }` the caller
// folds into its dirty-on-partial-failure logic (the SegmentSync push in contacts.ts). The
// suppress/mark-dirty decision lives in the caller, not here.

import type { ResendClientHandle } from "../resend/client.js";

/** Outcome of a segment membership mutation. `ok: false` ⇒ caller should mark the row dirty. */
export interface SegmentOpResult {
  /** True when Resend confirmed the mutation; false on a Resend error, throw, or unset key. */
  ok: boolean;
  /** Present when the op was a no-op because Resend is unset (key absent) — distinct from a failure. */
  skipped?: boolean;
  /** A short, non-PII reason on failure (Resend error message or "threw"). Never the email. */
  reason?: string;
}

/**
 * Add a contact (by email) to a Segment. Fail-soft: a Resend error or thrown transport error
 * returns `{ ok: false }` rather than throwing into the caller. An unset Resend key returns
 * `{ ok: false, skipped: true }` (nothing to push; the caller leaves the row dirty for reconcile).
 */
export async function addToSegment(
  resend: ResendClientHandle,
  email: string,
  segmentId: string
): Promise<SegmentOpResult> {
  const client = resend.client();
  if (!resend.enabled || client === null) {
    return { ok: false, skipped: true };
  }
  try {
    const { error } = await client.contacts.segments.add({ email, segmentId });
    if (error) {
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "threw" };
  }
}

/**
 * Remove a contact (by email) from a Segment. Same fail-soft contract as {@link addToSegment}. Used
 * by right-to-erasure (R34) best-effort membership teardown.
 */
export async function removeFromSegment(
  resend: ResendClientHandle,
  email: string,
  segmentId: string
): Promise<SegmentOpResult> {
  const client = resend.client();
  if (!resend.enabled || client === null) {
    return { ok: false, skipped: true };
  }
  try {
    const { error } = await client.contacts.segments.remove({ email, segmentId });
    if (error) {
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "threw" };
  }
}

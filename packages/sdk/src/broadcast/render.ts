import "server-only";

// Broadcast render + send (U12 / origin R17, R18, R19, R31, R32, KTD9).
//
// One call dispatches a Resend Broadcast from a saved Resend Template:
//   1. fetch the Template (cached) → raw `html`/`text` + declared variable specs
//   2. fill the Template's DECLARED `{{key}}` variables IN CODE (broadcasts.create takes
//      `{ html, text }`, NOT a `templateId` — verified against resend@6.14.0)
//   3. PRESERVE Resend merge tags verbatim — triple-brace `{{{FIRST_NAME|there}}}` and
//      `{{{RESEND_UNSUBSCRIBE_URL}}}` are per-contact tokens that Resend resolves at broadcast
//      send time; the SDK must never touch them, even when a declared variable shares a name.
//   4. `broadcasts.create({ segmentId, topicId, from, subject, html, text, name, send, scheduledAt })`
//
// The Topic is the unsubscribe gate (KTD9): every broadcast is scoped to a `topicId`, and Resend
// owns the native preference page reachable via `{{{RESEND_UNSUBSCRIBE_URL}}}`. There is no
// `List-Unsubscribe` header on a broadcast (`CreateBroadcastBaseOptions` exposes none, R33) — that
// header is a drip/transactional-lane concern only.

import type { ResendClientHandle } from "../resend/client.js";
import {
  getTemplate,
  type FetchedTemplate,
  type TemplateVariableSpec,
} from "../resend/templates.js";

/** Host-supplied values for the Template's declared variables. Scalars only (Resend's model). */
export type BroadcastVariables = Record<string, string | number | boolean | null | undefined>;

/** Raised when render or dispatch cannot proceed. Carries a stable, named contract message. */
export class BroadcastRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BroadcastRenderError";
  }
}

export interface RenderBroadcastInput {
  /** Saved Resend Template id to render from. */
  templateId: string;
  /** Values for the Template's declared `{{key}}` variables. Missing keys use the Template fallback. */
  variables?: BroadcastVariables;
}

export interface RenderedBroadcast {
  templateId: string;
  /** `html` body with declared variables filled and merge tags left verbatim. */
  html: string;
  /** `text` body, same substitution rules. `null` when the Template has no text part. */
  text: string | null;
}

// A single matcher that distinguishes Resend merge tags (`{{{ ... }}}`) from SDK-declared
// variables (`{{ key }}`). Matching BOTH forms in one left-to-right pass is what keeps a triple
// brace from being mis-parsed as `{` + `{{key}}` + `}`: the alternation tries the triple-brace
// form FIRST, so `{{{FIRST_NAME|there}}}` is consumed whole and preserved, never rewritten.
//   group 1 present → a `{{{...}}}` merge tag (preserve verbatim)
//   group 2 present → the inner key of a `{{ key }}` declared variable (substitute)
const TOKEN = /(\{\{\{[\s\S]*?\}\}\})|\{\{\s*([\w.-]+)\s*\}\}/g;

function scalarToString(value: string | number | boolean): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * Resolve a declared variable's replacement: host value wins, else the Template's declared
 * fallback, else empty string. `boolean`/`number` host values are stringified.
 */
function resolveValue(
  key: string,
  variables: BroadcastVariables | undefined,
  specByKey: Map<string, TemplateVariableSpec>
): string {
  const supplied = variables?.[key];
  if (supplied !== undefined && supplied !== null) {
    return scalarToString(supplied);
  }
  const spec = specByKey.get(key);
  if (spec && spec.fallback !== null) {
    return scalarToString(spec.fallback);
  }
  return "";
}

function fillBody(
  body: string,
  variables: BroadcastVariables | undefined,
  specByKey: Map<string, TemplateVariableSpec>
): string {
  return body.replace(TOKEN, (match, mergeTag: string | undefined, varKey: string | undefined) => {
    // A `{{{...}}}` Resend merge tag — preserve verbatim. This is the load-bearing line: per-contact
    // tokens like `{{{RESEND_UNSUBSCRIBE_URL}}}` MUST survive into broadcasts.create untouched.
    if (mergeTag !== undefined) return mergeTag;
    // A declared `{{ key }}` variable — substitute in code.
    if (varKey !== undefined) return resolveValue(varKey, variables, specByKey);
    return match;
  });
}

function indexVariables(template: FetchedTemplate): Map<string, TemplateVariableSpec> {
  const map = new Map<string, TemplateVariableSpec>();
  for (const spec of template.variables) map.set(spec.key, spec);
  return map;
}

/**
 * Fetch the (cached) Resend Template and fill its declared variables in code, preserving merge
 * tags verbatim. Returns broadcast-ready `{ html, text }`. Does NOT call `broadcasts.create` —
 * `sendBroadcast` composes this with dispatch; expose the pure render for hosts that want it.
 */
export async function renderBroadcast(
  resend: ResendClientHandle,
  input: RenderBroadcastInput
): Promise<RenderedBroadcast> {
  if (input === null || typeof input !== "object") {
    throw new BroadcastRenderError("[@envoy/sdk] renderBroadcast requires an input object.");
  }
  if (typeof input.templateId !== "string" || input.templateId.length === 0) {
    throw new BroadcastRenderError("[@envoy/sdk] renderBroadcast requires a non-empty templateId.");
  }

  const template = await getTemplate(resend, input.templateId);
  const specByKey = indexVariables(template);

  const html = fillBody(template.html, input.variables, specByKey);
  const text =
    template.text === null ? null : fillBody(template.text, input.variables, specByKey);

  return { templateId: template.id, html, text };
}

// Structural view of `client.broadcasts.create` — the broadcast lane never imports Resend's whole
// surface. `topicId` is the unsubscribe gate; `send: true` is single-call dispatch.
interface BroadcastsCreateClient {
  broadcasts: {
    create(payload: {
      segmentId: string;
      topicId?: string | null;
      from: string;
      subject: string;
      html: string;
      text?: string;
      name?: string;
      replyTo?: string | string[];
      previewText?: string;
      send?: boolean;
      scheduledAt?: string;
    }): Promise<{ data: { id: string } | null; error: { message?: string } | null }>;
  };
}

export interface SendBroadcastInput extends RenderBroadcastInput {
  /** Target Resend Segment (canonical broadcast target; `audienceId` is deprecated, R17). */
  segmentId: string;
  /** Topic to scope delivery + consent to (the unsubscribe gate, KTD9). */
  topicId: string;
  /** Verified sender address. */
  from: string;
  subject: string;
  /** Broadcast name — the SDK passes the send-once `broadcastKey` here so listings can find it (U11). */
  name?: string;
  replyTo?: string | string[];
  previewText?: string;
  /**
   * Dispatch immediately (`send: true`, the default) vs create-only. When `scheduledAt` is set,
   * Resend schedules instead of sending now.
   */
  send?: boolean;
  /** ISO timestamp (or Resend natural-language) to schedule the broadcast instead of sending now. */
  scheduledAt?: string;
}

export interface SendBroadcastResult {
  /** The Resend broadcast id returned by `broadcasts.create`. */
  broadcastId: string;
  html: string;
  text: string | null;
}

/**
 * Render a Resend Template and dispatch it as a Broadcast in a single call (origin R31/R32):
 * `templates.get` → fill in code → `broadcasts.create({ segmentId, topicId, html, text, send })`.
 *
 * No `templateId` and no headers are passed to `broadcasts.create` — broadcasts accept neither
 * (verified against resend@6.14.0). The Topic id carries the unsubscribe gate; the rendered html
 * still contains `{{{RESEND_UNSUBSCRIBE_URL}}}` for Resend to resolve per-contact.
 *
 * Fails loud when Resend is unset (rendering already requires the Template) or when
 * `broadcasts.create` errors — a broadcast that silently did not dispatch would be a compliance bug.
 */
export async function sendBroadcast(
  resend: ResendClientHandle,
  input: SendBroadcastInput
): Promise<SendBroadcastResult> {
  if (input === null || typeof input !== "object") {
    throw new BroadcastRenderError("[@envoy/sdk] sendBroadcast requires an input object.");
  }
  if (typeof input.segmentId !== "string" || input.segmentId.length === 0) {
    throw new BroadcastRenderError("[@envoy/sdk] sendBroadcast requires a non-empty segmentId.");
  }
  if (typeof input.topicId !== "string" || input.topicId.length === 0) {
    throw new BroadcastRenderError(
      "[@envoy/sdk] sendBroadcast requires a non-empty topicId — the Topic is the unsubscribe gate (KTD9)."
    );
  }
  if (typeof input.from !== "string" || input.from.trim().length === 0) {
    throw new BroadcastRenderError("[@envoy/sdk] sendBroadcast requires a non-empty from address.");
  }
  if (typeof input.subject !== "string" || input.subject.length === 0) {
    throw new BroadcastRenderError("[@envoy/sdk] sendBroadcast requires a non-empty subject.");
  }

  const rendered = await renderBroadcast(resend, {
    templateId: input.templateId,
    variables: input.variables,
  });

  const client = resend.client() as unknown as BroadcastsCreateClient | null;
  if (!resend.enabled || client === null) {
    // Unreachable in practice — renderBroadcast already threw on an unset Resend — but keeps the
    // dispatch path honest if a caller ever passes a pre-rendered body in future.
    throw new BroadcastRenderError(
      `[@envoy/sdk] cannot send broadcast "${input.name ?? input.templateId}": Resend is not configured.`
    );
  }

  const { data, error } = await client.broadcasts.create({
    segmentId: input.segmentId,
    topicId: input.topicId,
    from: input.from,
    subject: input.subject,
    html: rendered.html,
    ...(rendered.text !== null ? { text: rendered.text } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    ...(input.previewText !== undefined ? { previewText: input.previewText } : {}),
    send: input.send ?? true,
    ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
  });

  if (error || !data) {
    throw new BroadcastRenderError(
      `[@envoy/sdk] Resend broadcasts.create failed for "${input.name ?? input.templateId}": ` +
        `${error?.message ?? "unknown error"} (fail loud, R31/R32).`
    );
  }

  return { broadcastId: data.id, html: rendered.html, text: rendered.text };
}

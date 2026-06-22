import "server-only";

// Resend Template fetch + cache (U12 / origin R17, R18, R19, R32).
//
// The broadcast lane renders FROM a saved Resend Template, but — unlike the drip/transactional
// lane (`emails.send({ template: { id, variables } })`, where Resend substitutes server-side) —
// `broadcasts.create` takes `{ html, text }` only (no `templateId`, verified against resend@6.14.0).
// So a broadcast must fetch the Template's raw `html`/`text`, fill its declared `variables` IN
// CODE, then hand the rendered bodies to `broadcasts.create`. This module owns the fetch + a
// per-id cache so a multi-subject issue (or a resumed send) does not re-fetch the same Template.
//
// resend@6.14.0 fact: `templates.get(id)` → `{ data: Template | null, error }`, where `Template`
// exposes `html: string`, `text: string | null`, and `variables: TemplateVariable[] | null`
// (each `{ key, fallback_value, type }`). There is no `templateId` on broadcasts and no headers.

import type { ResendClientHandle } from "./client.js";

/**
 * A declared variable on a Resend Template. The SDK fills these in code for the broadcast lane.
 * `key` is the bare variable name (the `{{key}}` slot), `fallback` is the Template's own default
 * when the host supplies no value, `type` is Resend's declared scalar type.
 */
export interface TemplateVariableSpec {
  key: string;
  fallback: string | number | null;
  type: "string" | "number";
}

/**
 * The fields of a fetched Resend Template the broadcast renderer needs: the raw `html`/`text`
 * bodies (pre-substitution) and the declared variable specs. Everything else on the Resend
 * `Template` (status, timestamps, versioning) is irrelevant to rendering and dropped.
 */
export interface FetchedTemplate {
  id: string;
  html: string;
  text: string | null;
  variables: readonly TemplateVariableSpec[];
}

/** Raised when the Template cannot be fetched (Resend unset, not-found, or an upstream error). */
export class TemplateFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateFetchError";
  }
}

// Minimal structural view of `client.templates.get` so this module never imports Resend's whole
// surface and stays testable with a hand-rolled mock (same casting idiom as broadcast/claim.ts).
interface TemplatesGetClient {
  templates: {
    get(id: string): Promise<{
      data:
        | {
            id: string;
            html: string;
            text: string | null;
            variables:
              | { key: string; fallback_value: string | number | null; type: "string" | "number" }[]
              | null;
          }
        | null;
      error: { message?: string } | null;
    }>;
  };
}

// Per-id Template cache. Keyed by the raw Resend Template id (Templates are a Resend-global
// resource, not namespaced by install), so two installs sharing a Postgres still share the same
// upstream Template by id — there is nothing install-specific to fingerprint here. Bounded with
// FIFO eviction so a long-lived (non-serverless) host referencing many templates over its lifetime
// cannot grow it without limit; eviction only forces a re-fetch (correctness-neutral).
const TEMPLATE_CACHE_MAX = 256;
const templateCache = new Map<string, FetchedTemplate>();

function cacheTemplate(id: string, value: FetchedTemplate): void {
  if (templateCache.size >= TEMPLATE_CACHE_MAX && !templateCache.has(id)) {
    const oldest = templateCache.keys().next().value;
    if (oldest !== undefined) templateCache.delete(oldest);
  }
  templateCache.set(id, value);
}

/** Drop the cache (tests; or a host that knows a Template was edited upstream mid-process). */
export function clearTemplateCache(): void {
  templateCache.clear();
}

function normalizeVariables(
  raw:
    | { key: string; fallback_value: string | number | null; type: "string" | "number" }[]
    | null
    | undefined
): readonly TemplateVariableSpec[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw
      .filter((v): v is { key: string; fallback_value: string | number | null; type: "string" | "number" } =>
        v !== null && typeof v === "object" && typeof v.key === "string" && v.key.length > 0
      )
      .map((v) =>
        Object.freeze({
          key: v.key,
          fallback: v.fallback_value ?? null,
          type: v.type === "number" ? ("number" as const) : ("string" as const),
        })
      )
  );
}

/**
 * Fetch a Resend Template by id and return its render-relevant fields, caching the result.
 *
 * - A cache hit returns immediately and does NOT call Resend (satisfies "second send does not
 *   re-fetch"). Pass `{ refresh: true }` to force a re-fetch.
 * - Resend unset (no key) is a hard error here, not a no-op: the broadcast lane cannot render
 *   without the Template's bodies, so silently producing an empty broadcast would be a bug. This
 *   mirrors `provisionTopic`, which also refuses to no-op when a real upstream id is required.
 * - An upstream error or a missing Template (`data === null`) fails loud.
 */
export async function getTemplate(
  resend: ResendClientHandle,
  id: string,
  opts?: { refresh?: boolean }
): Promise<FetchedTemplate> {
  if (typeof id !== "string" || id.length === 0) {
    throw new TemplateFetchError("[@envoy/sdk] template id must be a non-empty string.");
  }

  if (!opts?.refresh) {
    const cached = templateCache.get(id);
    if (cached !== undefined) return cached;
  }

  const client = resend.client() as unknown as TemplatesGetClient | null;
  if (!resend.enabled || client === null) {
    throw new TemplateFetchError(
      `[@envoy/sdk] cannot fetch template "${id}": Resend is not configured (set RESEND_API_KEY). ` +
        `Broadcast rendering needs the Template's html/text and cannot be a no-op.`
    );
  }

  const { data, error } = await client.templates.get(id);
  if (error || !data) {
    throw new TemplateFetchError(
      `[@envoy/sdk] Resend templates.get failed for "${id}": ${error?.message ?? "template not found"}.`
    );
  }

  const fetched: FetchedTemplate = Object.freeze({
    id: data.id,
    html: data.html,
    text: data.text ?? null,
    variables: normalizeVariables(data.variables),
  });

  cacheTemplate(id, fetched);
  return fetched;
}

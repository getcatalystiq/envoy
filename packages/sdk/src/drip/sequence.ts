import "server-only";

import { type EnvoyAgentConfig, normalizeSequenceAgent } from "../config.js";

// Drip sequence definition (U8 / origin R12, R13, R15).
//
// A sequence is an ORDERED set of steps. Each step references a saved Resend Template by id, carries
// a per-step personalization brief, declares which Template variables the AI fills (`aiSlots`), and
// a time-based wait before it becomes eligible (R12/R15). Each step sends an individual
// transactional `emails.send` (NOT a Broadcast — R13); the engine (engine.ts) drives that.
//
// `defineSequence` is pure data + validation. It validates loud at definition time (R45-adjacent):
// a duplicate key, an empty step list, a missing templateId, or a negative wait is a definition
// error, not a runtime surprise. Config-time AI-slots ⇄ Template-variables validation (the real
// network check) lands in U18 via `envoy.validate()`; here we only validate the shape.

/**
 * The kind of email block an AI slot fills. Drives the agent's output format (`Text`/`Heading` →
 * plain text; `Button`/`Html` → HTML) and image eligibility. Mirrors the drip agent's `block_type`
 * contract field.
 */
export type BlockType = "Text" | "Heading" | "Button" | "Html";

/** The default block type for a slot with no explicit type (back-compat for bare-string slots). */
export const DEFAULT_BLOCK_TYPE: BlockType = "Text";

/** One step of a drip sequence. */
export interface SequenceStep {
  /** Saved Resend Template id this step sends (`emails.send({ template: { id } })`, R12). */
  templateId: string;
  /**
   * Time-based wait before this step is eligible, in days, resolved against the cron clock (R15).
   * `0` ⇒ eligible immediately on reaching the step. Fractional values are allowed (e.g. `0.5` =
   * 12h). Must be ≥ 0.
   */
  waitDays: number;
  /**
   * The Template variable names the AI fills at send time (R12/R14). Each must exist as a variable
   * on the referenced Template — verified by `envoy.validate()` (U18), not here. May be empty for a
   * non-AI step (a fully static Template).
   */
  aiSlots: readonly string[];
  /**
   * Per-slot block type, keyed by the slot name in `aiSlots`. Drives the per-block agent contract's
   * `block_type`. A slot absent from this map defaults to {@link DEFAULT_BLOCK_TYPE} (`Text`) — so a
   * legacy step with bare-string slots and no map keeps working unchanged.
   */
  slotBlockTypes?: Readonly<Record<string, BlockType>>;
  /** The per-step personalization brief the agent is given (R12). May be empty when `aiSlots` is. */
  brief: string;
}

const BLOCK_TYPES: ReadonlySet<string> = new Set<BlockType>(["Text", "Heading", "Button", "Html"]);

/** Resolve a slot's block type from a step, defaulting to `Text` when unset/invalid (back-compat). */
export function blockTypeForSlot(step: SequenceStep, slotName: string): BlockType {
  const t = step.slotBlockTypes?.[slotName];
  return t && BLOCK_TYPES.has(t) ? t : DEFAULT_BLOCK_TYPE;
}

/** A defined, validated drip sequence. Immutable. */
export interface Sequence {
  /** Stable sequence key (the `sequence_key` an enrollment is scoped to). */
  readonly key: string;
  /** The ordered steps. Index is the step's position (`sdk_steps.step_index`). */
  readonly steps: readonly Readonly<SequenceStep>[];
  /**
   * OPTIONAL per-sequence agent override. When set, the drip engine resolves THIS agent for the
   * sequence's AI steps instead of the global `envoy.config.agent`. Carried through the load path
   * (store.rowToSequence) so the live cron sees it — not only `getSequence`.
   */
  readonly agent?: EnvoyAgentConfig;
}

/** Inputs to {@link defineSequence}. */
export interface DefineSequenceInput {
  key: string;
  steps: SequenceStep[];
  /** Optional per-sequence agent override `{agentId, environmentId, vaultId?}`. */
  agent?: EnvoyAgentConfig;
}

/** Raised when a sequence definition is malformed (fail loud at definition time). */
export class SequenceDefinitionError extends Error {
  constructor(message: string) {
    super(`[@catalystiq/envoy-sdk] ${message}`);
    this.name = "SequenceDefinitionError";
  }
}

function validateStep(step: SequenceStep, index: number): Readonly<SequenceStep> {
  if (step === null || typeof step !== "object") {
    throw new SequenceDefinitionError(`step ${index} must be an object.`);
  }
  if (typeof step.templateId !== "string" || step.templateId.trim().length === 0) {
    throw new SequenceDefinitionError(`step ${index} requires a non-empty templateId.`);
  }
  if (typeof step.waitDays !== "number" || !Number.isFinite(step.waitDays) || step.waitDays < 0) {
    throw new SequenceDefinitionError(
      `step ${index} requires a finite, non-negative waitDays (got ${String(step.waitDays)}).`,
    );
  }
  const aiSlots = step.aiSlots ?? [];
  if (!Array.isArray(aiSlots)) {
    throw new SequenceDefinitionError(`step ${index} aiSlots must be an array of variable names.`);
  }
  for (const slot of aiSlots) {
    if (typeof slot !== "string" || slot.trim().length === 0) {
      throw new SequenceDefinitionError(
        `step ${index} aiSlots must contain only non-empty variable names.`,
      );
    }
  }
  if (new Set(aiSlots).size !== aiSlots.length) {
    throw new SequenceDefinitionError(`step ${index} aiSlots contains duplicate names.`);
  }
  const brief = step.brief ?? "";
  if (typeof brief !== "string") {
    throw new SequenceDefinitionError(`step ${index} brief must be a string.`);
  }
  if (aiSlots.length > 0 && brief.trim().length === 0) {
    throw new SequenceDefinitionError(
      `step ${index} declares aiSlots but has an empty brief — the agent has nothing to act on.`,
    );
  }

  // Per-slot block types (optional). Validate when present: every key must be a declared slot and
  // every value a valid BlockType — then CARRY IT THROUGH (this rebuild would otherwise drop it, so
  // the type would never survive defineSequence → store → engine). An empty/absent map is omitted.
  let slotBlockTypes: Readonly<Record<string, BlockType>> | undefined;
  if (step.slotBlockTypes !== undefined && step.slotBlockTypes !== null) {
    if (typeof step.slotBlockTypes !== "object") {
      throw new SequenceDefinitionError(`step ${index} slotBlockTypes must be an object.`);
    }
    const slotSet = new Set(aiSlots);
    const normalized: Record<string, BlockType> = {};
    for (const [slot, type] of Object.entries(step.slotBlockTypes)) {
      if (!slotSet.has(slot)) {
        throw new SequenceDefinitionError(
          `step ${index} slotBlockTypes references "${slot}", which is not a declared aiSlot.`,
        );
      }
      if (!BLOCK_TYPES.has(type)) {
        throw new SequenceDefinitionError(
          `step ${index} slotBlockTypes["${slot}"] must be one of Text/Heading/Button/Html (got ${String(type)}).`,
        );
      }
      normalized[slot] = type;
    }
    if (Object.keys(normalized).length > 0) slotBlockTypes = Object.freeze(normalized);
  }

  return Object.freeze({
    templateId: step.templateId,
    waitDays: step.waitDays,
    aiSlots: Object.freeze([...aiSlots]),
    ...(slotBlockTypes ? { slotBlockTypes } : {}),
    brief,
  });
}

/**
 * Define a drip sequence (R12/R13/R15). Validates loud: a missing key, an empty step list, a bad
 * templateId, a negative wait, or a malformed slot declaration throws `SequenceDefinitionError`.
 * Returns a frozen `Sequence` whose steps are positionally indexed (`step_index`).
 */
export function defineSequence(input: DefineSequenceInput): Sequence {
  if (input === null || typeof input !== "object") {
    throw new SequenceDefinitionError("defineSequence requires an input object.");
  }
  if (typeof input.key !== "string" || input.key.trim().length === 0) {
    throw new SequenceDefinitionError("defineSequence requires a non-empty key.");
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new SequenceDefinitionError(
      `sequence "${input.key}" requires at least one step.`,
    );
  }
  const steps = input.steps.map((step, i) => validateStep(step, i));
  // Validate + freeze the optional agent (agentId + environmentId required when present; vaultId
  // optional). normalizeSequenceAgent throws a clear error on a half-configured agent.
  const agent = normalizeSequenceAgent(input.agent);
  return Object.freeze(
    agent
      ? { key: input.key, steps: Object.freeze(steps), agent }
      : { key: input.key, steps: Object.freeze(steps) },
  );
}

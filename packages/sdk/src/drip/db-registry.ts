import "server-only";

import type { Envoy } from "../config.js";
import type { Sequence } from "./sequence.js";
import { loadAllSequenceDefs } from "./store.js";

// U-S2 — bridge the DB store to the engine's SYNC SequenceRegistry contract.
//
// `resolveSequence` (engine.ts) is synchronous — `registry(key) => Sequence | undefined`, called
// inside the tick with no await. A DB read is async, so the registry cannot read the DB per resolve.
// Instead the DB registry resolves from an in-memory snapshot that the host reloads (`refresh()`)
// before each tick. The host wraps its drip-cron / MCP SubHandlers to `await refresh()` first; the
// engine, `tickDrip`, and `enroll` stay untouched.

export interface DbSequenceRegistry {
  /** The sync registry the engine consumes (`SequenceRegistry` function arm). Reads the snapshot. */
  resolve: (sequenceKey: string) => Sequence | undefined;
  /** Reload the in-memory snapshot from `sdk_sequence_defs`. The host awaits this before each tick. */
  refresh: () => Promise<void>;
}

/**
 * A DB-backed registry: `resolve` answers from an in-memory `key → Sequence` snapshot, `refresh`
 * reloads it. Definitions are reconstructed through `defineSequence` on load (store.ts), so a
 * malformed row is skipped (logged) rather than poisoning the snapshot.
 */
export function createDbSequenceRegistry(envoy: Envoy): DbSequenceRegistry {
  let snapshot: ReadonlyMap<string, Sequence> = new Map();
  return {
    resolve: (sequenceKey) => snapshot.get(sequenceKey),
    refresh: async () => {
      snapshot = await loadAllSequenceDefs(envoy.db);
    },
  };
}

/** Structural equality of two definitions — both are frozen `defineSequence` outputs with a stable
 *  key order, so a JSON compare is exact. Used only for the divergence warning. */
function sameSequence(a: Sequence, b: Sequence): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compose a DB resolver over a code-defined `Map` fallback. **DB wins** when a key exists in both
 * (the cutover scaffold: a host seeds the DB while keeping `buildOnboarding()` as a fallback, then
 * retires the code def). Because DB-first silently *shadows* the reviewed/tested code def, a
 * divergence between the two emits a warning so the override is observable, never silent.
 */
export function createCompositeRegistry(
  primary: (sequenceKey: string) => Sequence | undefined,
  fallback: ReadonlyMap<string, Sequence>,
  opts?: { onDivergence?: (sequenceKey: string) => void },
): (sequenceKey: string) => Sequence | undefined {
  const onDivergence =
    opts?.onDivergence ??
    ((sequenceKey: string) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[@catalystiq/envoy-sdk] DB sequence "${sequenceKey}" differs from its code fallback — ` +
          `DB definition wins (composite registry). Retire the code def once the DB def is confirmed live.`,
      );
    });
  return (sequenceKey) => {
    const dbDef = primary(sequenceKey);
    const codeDef = fallback.get(sequenceKey);
    if (dbDef !== undefined && codeDef !== undefined && !sameSequence(dbDef, codeDef)) {
      onDivergence(sequenceKey);
    }
    return dbDef ?? codeDef;
  };
}

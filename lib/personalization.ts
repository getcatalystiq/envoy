/**
 * Parallel personalization processing for sequence blocks.
 * Port of functions/sequence_scheduler/personalization.py
 */

import { invokeSkill } from "@/lib/agentplane";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyData = Record<string, any>;
type BlockMap = Record<string, AnyData>;

export interface PersonalizationError {
  blockId: string;
  error: string;
}

const ALLOWED_TARGET_FIELDS = new Set([
  "first_name",
  "last_name",
  "company",
  "role",
  "email",
  "phone",
]);

function parseMetadata(metadata: unknown): AnyData | null {
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    return metadata as AnyData;
  }

  if (typeof metadata === "string") {
    let value: string = metadata;
    for (let i = 0; i < 3; i++) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed as AnyData;
        }
        if (typeof parsed === "string") {
          value = parsed;
        } else {
          return null;
        }
      } catch {
        return null;
      }
    }
  }

  return null;
}

function sanitizeTargetData(target: AnyData): AnyData {
  const result: AnyData = {};
  for (const field of ALLOWED_TARGET_FIELDS) {
    if (field in target && target[field]) {
      result[field] = String(target[field]).slice(0, 100);
    }
  }

  const metadata = parseMetadata(target.metadata);
  if (metadata) {
    const sanitized: AnyData = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === "string") {
        sanitized[key] = value.slice(0, 500);
      } else if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        sanitized[key] = value;
      } else if (Array.isArray(value)) {
        sanitized[key] = value
          .slice(0, 20)
          .filter(
            (v) =>
              typeof v === "string" ||
              typeof v === "number" ||
              typeof v === "boolean" ||
              v === null
          )
          .map((v) => (typeof v === "string" ? v.slice(0, 500) : v));
      }
    }
    if (Object.keys(sanitized).length > 0) {
      result.metadata = sanitized;
    }
  }

  return result;
}

function extractBlockContent(block: AnyData): string | null {
  const blockType = block.type;
  const props = block.data?.props;
  if (!props) return null;

  if (blockType === "Text" || blockType === "Heading" || blockType === "Button") {
    return props.text || null;
  }
  if (blockType === "Html") {
    return props.contents || null;
  }
  return null;
}

function applyPersonalizedContent(block: AnyData, personalized: string): AnyData {
  const result: AnyData = JSON.parse(JSON.stringify(block));
  const blockType = result.type;

  if (blockType === "Text" || blockType === "Heading" || blockType === "Button") {
    result.data.props.text = personalized;
  } else if (blockType === "Html") {
    result.data.props.contents = personalized;
  }
  return result;
}

async function personalizeBlock(
  blockId: string,
  block: AnyData,
  targetData: AnyData,
  agentId: string,
  timeoutMs: number
): Promise<{
  blockId: string;
  result: AnyData | null;
  error: PersonalizationError | null;
}> {
  const personalization = block.data?.personalization;
  if (!personalization?.enabled) {
    return { blockId, result: null, error: null };
  }

  const prompt = (personalization.prompt || "").trim();
  const blockType = block.type;
  const originalContent = extractBlockContent(block);

  if (!originalContent) {
    return { blockId, result: null, error: null };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const aiResult = await invokeSkill(agentId, "envoy-content-generation", {
        mode: "block_personalization",
        original_content: originalContent,
        additional_instructions: prompt,
        target: sanitizeTargetData(targetData),
        block_type: blockType,
      });

      const personalized =
        (aiResult.body as string) ||
        (aiResult.content as string) ||
        (aiResult.raw as string) ||
        originalContent;

      if (personalized === originalContent) {
        console.warn(
          `Block ${blockId}: AI returned no usable content, keeping original. Keys: ${Object.keys(aiResult)}`
        );
      } else {
        console.log(
          `Block ${blockId}: personalized (${originalContent.length} chars -> ${personalized.length} chars)`
        );
      }

      const updatedBlock = applyPersonalizedContent(block, personalized);
      return { blockId, result: updatedBlock, error: null };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError"
      ? "Timeout"
      : String(err);
    console.warn(`Personalization failed for block ${blockId}: ${message}`);
    return {
      blockId,
      result: null,
      error: { blockId, error: message },
    };
  }
}

export function hasPersonalizedBlocks(builderContent: BlockMap | null | undefined): boolean {
  if (!builderContent) return false;

  for (const block of Object.values(builderContent)) {
    if (block.data?.personalization?.enabled) return true;
  }
  return false;
}

export async function processPersonalization(
  builderContent: BlockMap,
  targetData: AnyData,
  agentId: string,
  opts: { maxConcurrent?: number; timeoutMs?: number } = {}
): Promise<{ content: BlockMap; errors: PersonalizationError[] }> {
  if (!builderContent) {
    return { content: builderContent, errors: [] };
  }

  const { maxConcurrent = 5, timeoutMs = 45_000 } = opts;
  const modifiedContent: BlockMap = JSON.parse(JSON.stringify(builderContent));

  // Collect blocks that need personalization
  const blockEntries = Object.entries(modifiedContent);

  // Process with bounded concurrency
  const errors: PersonalizationError[] = [];
  let active = 0;

  const promises = blockEntries.map(async ([blockId, block]) => {
    while (active >= maxConcurrent) {
      await new Promise((r) => setTimeout(r, 10));
    }
    active++;

    try {
      return await personalizeBlock(blockId, block, targetData, agentId, timeoutMs);
    } finally {
      active--;
    }
  });

  const results = await Promise.allSettled(promises);

  for (const settled of results) {
    if (settled.status === "rejected") continue;
    const { blockId, result, error } = settled.value;
    if (error) {
      errors.push(error);
    } else if (result !== null) {
      modifiedContent[blockId] = result;
    }
  }

  console.log(
    `Personalization complete: ${results.length - errors.length} blocks processed, ${errors.length} errors`
  );

  return { content: modifiedContent, errors };
}

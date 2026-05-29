/**
 * Parallel personalization processing for sequence blocks.
 */

import { runAgentJson } from "@/lib/twin";
import { sanitizeTargetForTwin } from "@/lib/twin-sanitize";


type AnyData = Record<string, any>;
type BlockMap = Record<string, AnyData>;

export interface PersonalizationError {
  blockId: string;
  error: string;
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
  apiKey: string | undefined,
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
    const message = buildPersonalizationPrompt({
      originalContent,
      additionalInstructions: prompt,
      target: sanitizeTargetForTwin(targetData),
      blockType,
    });
    const aiResult = await runAgentJson(agentId, message, { timeoutMs, apiKey });

    const personalized =
      (aiResult.body as string | undefined) ??
      (aiResult.content as string | undefined) ??
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
  } catch (err) {
    const message = String(err);
    console.warn(`Personalization failed for block ${blockId}: ${message}`);
    return {
      blockId,
      result: null,
      error: { blockId, error: message },
    };
  }
}

function buildPersonalizationPrompt(args: {
  originalContent: string;
  additionalInstructions: string;
  target: AnyData;
  blockType: string;
}): string {
  return [
    `Personalize this ${args.blockType} email block for the given target.`,
    "",
    `Original content:\n${args.originalContent}`,
    "",
    args.additionalInstructions
      ? `Additional instructions:\n${args.additionalInstructions}`
      : "",
    `Target:\n${JSON.stringify(args.target, null, 2)}`,
    "",
    `Respond with JSON containing a "body" field with the personalized content. Keep the same format and tone as the original.`,
  ]
    .filter(Boolean)
    .join("\n");
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
  apiKey: string | undefined,
  opts: { maxConcurrent?: number; timeoutMs?: number } = {}
): Promise<{ content: BlockMap; errors: PersonalizationError[] }> {
  if (!builderContent) {
    return { content: builderContent, errors: [] };
  }

  const { maxConcurrent = 5, timeoutMs = 45_000 } = opts;
  const modifiedContent: BlockMap = JSON.parse(JSON.stringify(builderContent));

  // Collect blocks that need personalization
  const blockEntries = Object.entries(modifiedContent);

  // Promise-based semaphore: callers awaiting acquire() join a FIFO queue
  // and resolve as slots free up in release().
  const semaphore = (() => {
    let permits = maxConcurrent;
    const waiters: Array<() => void> = [];
    return {
      acquire(): Promise<void> {
        if (permits > 0) {
          permits--;
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => waiters.push(resolve));
      },
      release(): void {
        const next = waiters.shift();
        if (next) next();
        else permits++;
      },
    };
  })();

  // Process with bounded concurrency
  const errors: PersonalizationError[] = [];

  const promises = blockEntries.map(async ([blockId, block]) => {
    await semaphore.acquire();
    try {
      return await personalizeBlock(blockId, block, targetData, agentId, apiKey, timeoutMs);
    } finally {
      semaphore.release();
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

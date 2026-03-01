/**
 * Simple template engine for email variable replacement.
 * Port of functions/sequence_scheduler/template_engine.py
 */
import { getEnv } from "@/lib/env";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BlockMap = Record<string, Record<string, any>>;

function replaceTemplatesInText(
  text: string,
  replacements: Record<string, string>
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, varName: string) => {
    return replacements[varName] ?? match;
  });
}

export function replaceTemplatesInBlocks(
  builderContent: BlockMap,
  targetData: Record<string, string | undefined | null>,
  targetId: string
): BlockMap {
  const baseUrl = getEnv().NEXT_PUBLIC_URL;

  const replacements: Record<string, string> = {
    first_name: targetData.first_name || "",
    last_name: targetData.last_name || "",
    company: targetData.company || "",
    title: targetData.title || "",
    email: targetData.email || "",
    unsubscribe_link: `${baseUrl}/unsubscribe/${targetId}`,
  };

  // Deep clone
  const result: BlockMap = JSON.parse(JSON.stringify(builderContent));

  for (const block of Object.values(result)) {
    const blockType = block.type;
    const props = block.data?.props;
    if (!props) continue;

    if (
      (blockType === "Text" || blockType === "Heading" || blockType === "Button") &&
      typeof props.text === "string"
    ) {
      props.text = replaceTemplatesInText(props.text, replacements);
    } else if (blockType === "Html" && typeof props.contents === "string") {
      props.contents = replaceTemplatesInText(props.contents, replacements);
    }
  }

  return result;
}

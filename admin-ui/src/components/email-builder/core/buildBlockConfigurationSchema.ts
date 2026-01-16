import { z } from 'zod';

import { BaseZodDictionary, BlockConfiguration, DocumentBlocksDictionary } from './utils';

/**
 * Schema for block-level personalization configuration.
 * This is added to all blocks to support AI-powered content personalization.
 */
export const PersonalizationSchema = z
  .object({
    enabled: z.boolean(),
    prompt: z.string(),
  })
  .optional();

export type PersonalizationConfig = z.infer<typeof PersonalizationSchema>;

/**
 *
 * @param blocks Main DocumentBlocksDictionary
 * @returns zod schema that can parse arbitrary objects into a single BlockConfiguration
 */
export default function buildBlockConfigurationSchema<T extends BaseZodDictionary>(
  blocks: DocumentBlocksDictionary<T>
) {
  const blockObjects = Object.keys(blocks).map((type: keyof T) =>
    z.object({
      type: z.literal(type as string),
      data: blocks[type].schema.extend({
        personalization: PersonalizationSchema,
      }),
    })
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return z.discriminatedUnion('type', blockObjects as any).transform((v) => v as BlockConfiguration<T>);
}

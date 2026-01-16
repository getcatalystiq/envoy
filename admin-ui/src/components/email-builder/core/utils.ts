import { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BaseZodDictionary = { [name: string]: z.ZodObject<any> };
export type DocumentBlocksDictionary<T extends BaseZodDictionary> = {
  [K in keyof T]: {
    schema: T[K];
    Component: (props: z.infer<T[K]>) => JSX.Element;
  };
};

/**
 * Personalization configuration that can be attached to any block.
 */
export type PersonalizationConfig = {
  enabled: boolean;
  prompt: string;
};

export type BlockConfiguration<T extends BaseZodDictionary> = {
  [TType in keyof T]: {
    type: TType;
    data: z.infer<T[TType]> & {
      personalization?: PersonalizationConfig;
    };
  };
}[keyof T];

export class BlockNotFoundError extends Error {
  blockId: string;
  constructor(blockId: string) {
    super('Could not find a block with the given blockId');
    this.blockId = blockId;
  }
}

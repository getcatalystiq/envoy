// Global type declarations for email-builder-js editor
import { z } from 'zod';
import React from 'react';

declare global {
  namespace Zod {
    type ZodError = z.ZodError;
    type infer<T extends z.ZodType<unknown, z.ZodTypeDef, unknown>> = z.infer<T>;
  }

  namespace JSX {
    type Element = React.JSX.Element;
  }
}

export {};

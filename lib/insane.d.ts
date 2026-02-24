declare module 'insane' {
  interface InsaneOptions {
    allowedTags?: string[];
    allowedSchemes?: string[];
    allowedAttributes?: Record<string, string[]>;
    filter?: (token: { tag: string; attrs: Record<string, string | undefined> }) => boolean;
  }

  function insane(html: string, options?: InsaneOptions): string;
  export default insane;
}

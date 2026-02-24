'use client';
import { z } from 'zod';
import { COLOR_SCHEMA, PADDING_SCHEMA, FONT_FAMILY_SCHEMA, getFontFamily, getPadding } from '../shared';

export const HtmlPropsSchema = z.object({
  style: z.object({
    color: COLOR_SCHEMA,
    backgroundColor: COLOR_SCHEMA,
    fontFamily: FONT_FAMILY_SCHEMA,
    fontSize: z.number().min(0).optional().nullable(),
    textAlign: z.enum(['left', 'right', 'center']).optional().nullable(),
    padding: PADDING_SCHEMA,
  }).optional().nullable(),
  props: z.object({
    contents: z.string().optional().nullable(),
  }).optional().nullable(),
});

export type HtmlProps = z.infer<typeof HtmlPropsSchema>;

export function Html({ style, props }: HtmlProps) {
  const children = props?.contents;

  const cssStyle = {
    color: style?.color ?? undefined,
    backgroundColor: style?.backgroundColor ?? undefined,
    fontFamily: getFontFamily(style?.fontFamily),
    fontSize: style?.fontSize ?? undefined,
    textAlign: style?.textAlign ?? undefined,
    padding: getPadding(style?.padding),
  };

  if (!children) {
    return <div style={cssStyle} />;
  }

  return (
    <div
      style={cssStyle}
      className="email-markdown-content"
      dangerouslySetInnerHTML={{ __html: children }}
    />
  );
}

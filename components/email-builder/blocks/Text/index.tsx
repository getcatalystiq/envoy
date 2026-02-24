'use client';
import { z } from 'zod';
import { COLOR_SCHEMA, PADDING_SCHEMA, FONT_FAMILY_SCHEMA, getFontFamily, getPadding } from '../shared';
import { EmailMarkdown } from './EmailMarkdown';

export const TextPropsSchema = z.object({
  style: z.object({
    color: COLOR_SCHEMA,
    backgroundColor: COLOR_SCHEMA,
    fontSize: z.number().gte(0).optional().nullable(),
    fontFamily: FONT_FAMILY_SCHEMA,
    fontWeight: z.enum(['bold', 'normal']).optional().nullable(),
    textAlign: z.enum(['left', 'center', 'right']).optional().nullable(),
    padding: PADDING_SCHEMA,
  }).optional().nullable(),
  props: z.object({
    markdown: z.boolean().optional().nullable(),
    text: z.string().optional().nullable(),
  }).optional().nullable(),
});

export type TextProps = z.infer<typeof TextPropsSchema>;

export const TextPropsDefaults = {
  text: '',
};

export function Text({ style, props }: TextProps) {
  const wStyle = {
    color: style?.color ?? undefined,
    backgroundColor: style?.backgroundColor ?? undefined,
    fontSize: style?.fontSize ?? undefined,
    fontFamily: getFontFamily(style?.fontFamily),
    fontWeight: style?.fontWeight ?? undefined,
    textAlign: style?.textAlign ?? undefined,
    padding: getPadding(style?.padding),
  };

  const text = props?.text ?? TextPropsDefaults.text;

  // Always render as markdown to support HTML (ul/li, links, etc.)
  return <EmailMarkdown style={wStyle} markdown={text} />;
}

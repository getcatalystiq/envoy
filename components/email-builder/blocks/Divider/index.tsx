'use client';
import { z } from 'zod';
import { COLOR_SCHEMA, PADDING_SCHEMA, getPadding } from '../shared';

export const DividerPropsSchema = z.object({
  style: z.object({
    backgroundColor: COLOR_SCHEMA,
    padding: PADDING_SCHEMA,
  }).optional().nullable(),
  props: z.object({
    lineColor: COLOR_SCHEMA,
    lineHeight: z.number().optional().nullable(),
  }).optional().nullable(),
});

export type DividerProps = z.infer<typeof DividerPropsSchema>;

export const DividerPropsDefaults = {
  lineHeight: 1,
  lineColor: '#333333',
};

export function Divider({ style, props }: DividerProps) {
  const st = {
    padding: getPadding(style?.padding),
    backgroundColor: style?.backgroundColor ?? undefined,
  };

  const borderTopWidth = props?.lineHeight ?? DividerPropsDefaults.lineHeight;
  const borderTopColor = props?.lineColor ?? DividerPropsDefaults.lineColor;

  return (
    <div style={st}>
      <hr
        style={{
          width: '100%',
          border: 'none',
          borderTop: `${borderTopWidth}px solid ${borderTopColor}`,
          margin: 0,
        }}
      />
    </div>
  );
}

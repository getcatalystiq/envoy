'use client';
import { ReactNode } from 'react';
import { z } from 'zod';
import { COLOR_SCHEMA, PADDING_SCHEMA, getPadding } from '../shared';

export const ContainerPropsSchema = z.object({
  style: z.object({
    backgroundColor: COLOR_SCHEMA,
    borderColor: COLOR_SCHEMA,
    borderRadius: z.number().optional().nullable(),
    padding: PADDING_SCHEMA,
  }).optional().nullable(),
});

export type ContainerStyleProps = z.infer<typeof ContainerPropsSchema>;

interface ContainerProps extends ContainerStyleProps {
  children?: ReactNode;
}

function getBorder(style: ContainerStyleProps['style']): string | undefined {
  if (!style || !style.borderColor) {
    return undefined;
  }
  return `1px solid ${style.borderColor}`;
}

export function Container({ style, children }: ContainerProps) {
  const wStyle = {
    backgroundColor: style?.backgroundColor ?? undefined,
    border: getBorder(style),
    borderRadius: style?.borderRadius ?? undefined,
    padding: getPadding(style?.padding),
  };

  if (!children) {
    return <div style={wStyle} />;
  }

  return <div style={wStyle}>{children}</div>;
}

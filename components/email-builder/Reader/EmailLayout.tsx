'use client';
import { ReactNode } from 'react';
import { z } from 'zod';
import { COLOR_SCHEMA, FONT_FAMILY_SCHEMA, getFontFamily, FontFamily } from '../blocks/shared';

export const EmailLayoutPropsSchema = z.object({
  backdropColor: COLOR_SCHEMA,
  borderColor: COLOR_SCHEMA,
  borderRadius: z.number().optional().nullable(),
  canvasColor: COLOR_SCHEMA,
  textColor: COLOR_SCHEMA,
  fontFamily: FONT_FAMILY_SCHEMA,
  childrenIds: z.array(z.string()).optional().nullable(),
});

export type EmailLayoutProps = z.infer<typeof EmailLayoutPropsSchema>;

interface EmailLayoutReaderProps extends EmailLayoutProps {
  children?: ReactNode;
}

function getBorder({ borderColor }: { borderColor?: string | null }): string | undefined {
  if (!borderColor) {
    return undefined;
  }
  return `1px solid ${borderColor}`;
}

export function EmailLayoutReader(props: EmailLayoutReaderProps) {
  return (
    <div
      style={{
        backgroundColor: props.backdropColor ?? '#F5F5F5',
        color: props.textColor ?? '#262626',
        fontFamily: getFontFamily(props.fontFamily as FontFamily),
        fontSize: '16px',
        fontWeight: '400',
        letterSpacing: '0.15008px',
        lineHeight: '1.5',
        margin: '0',
        padding: '32px 0',
        minHeight: '100%',
        width: '100%',
      }}
    >
      <table
        align="center"
        width="100%"
        style={{
          margin: '0 auto',
          maxWidth: '600px',
          backgroundColor: props.canvasColor ?? '#FFFFFF',
          borderRadius: props.borderRadius ?? undefined,
          border: getBorder(props),
        }}
        role="presentation"
        cellSpacing="0"
        cellPadding="0"
        border={0}
      >
        <tbody>
          <tr style={{ width: '100%' }}>
            <td>{props.children}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

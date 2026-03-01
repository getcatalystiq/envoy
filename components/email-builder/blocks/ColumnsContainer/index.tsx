'use client';
import { ReactNode } from 'react';
import { z } from 'zod';
import { COLOR_SCHEMA, PADDING_SCHEMA, getPadding } from '../shared';

const FIXED_WIDTHS_SCHEMA = z.tuple([z.number().nullish(), z.number().nullish(), z.number().nullish()]).optional().nullable();

export const ColumnsContainerPropsSchema = z.object({
  style: z.object({
    backgroundColor: COLOR_SCHEMA,
    padding: PADDING_SCHEMA,
  }).optional().nullable(),
  props: z.object({
    fixedWidths: FIXED_WIDTHS_SCHEMA,
    columnsCount: z.union([z.literal(2), z.literal(3)]).optional().nullable(),
    columnsGap: z.number().optional().nullable(),
    contentAlignment: z.enum(['top', 'middle', 'bottom']).optional().nullable(),
  }).optional().nullable(),
});

export type ColumnsContainerStyleProps = z.infer<typeof ColumnsContainerPropsSchema>;

interface ColumnsContainerProps extends ColumnsContainerStyleProps {
  columns?: ReactNode[];
}

export const ColumnsContainerPropsDefaults = {
  columnsCount: 2 as const,
  columnsGap: 0,
  contentAlignment: 'middle' as const,
};

interface TableCellProps {
  index: number;
  props: {
    columnsCount: 2 | 3;
    columnsGap: number;
    contentAlignment: 'top' | 'middle' | 'bottom';
    fixedWidths?: [(number | null | undefined)?, (number | null | undefined)?, (number | null | undefined)?] | null;
  };
  columns?: ReactNode[];
}

function getPaddingBefore(index: number, { columnsGap, columnsCount }: { columnsGap: number; columnsCount: 2 | 3 }): number {
  if (index === 0) {
    return 0;
  }
  if (columnsCount === 2) {
    return columnsGap / 2;
  }
  if (index === 1) {
    return columnsGap / 3;
  }
  return (2 * columnsGap) / 3;
}

function getPaddingAfter(index: number, { columnsGap, columnsCount }: { columnsGap: number; columnsCount: 2 | 3 }): number {
  if (columnsCount === 2) {
    if (index === 0) {
      return columnsGap / 2;
    }
    return 0;
  }
  if (index === 0) {
    return (2 * columnsGap) / 3;
  }
  if (index === 1) {
    return columnsGap / 3;
  }
  return 0;
}

function TableCell({ index, props, columns }: TableCellProps) {
  const contentAlignment = props?.contentAlignment ?? ColumnsContainerPropsDefaults.contentAlignment;
  const columnsCount = props?.columnsCount ?? ColumnsContainerPropsDefaults.columnsCount;

  if (columnsCount === 2 && index === 2) {
    return null;
  }

  const style = {
    boxSizing: 'content-box' as const,
    verticalAlign: contentAlignment,
    paddingLeft: getPaddingBefore(index, props),
    paddingRight: getPaddingAfter(index, props),
    width: props.fixedWidths?.[index] ?? undefined,
  };

  const children = columns && columns[index] ? columns[index] : null;

  return <td style={style}>{children}</td>;
}

export function ColumnsContainer({ style, columns, props }: ColumnsContainerProps) {
  const wStyle = {
    backgroundColor: style?.backgroundColor ?? undefined,
    padding: getPadding(style?.padding),
  };

  const blockProps = {
    columnsCount: props?.columnsCount ?? ColumnsContainerPropsDefaults.columnsCount,
    columnsGap: props?.columnsGap ?? ColumnsContainerPropsDefaults.columnsGap,
    contentAlignment: props?.contentAlignment ?? ColumnsContainerPropsDefaults.contentAlignment,
    fixedWidths: props?.fixedWidths,
  };

  return (
    <div style={wStyle}>
      <table
        align="center"
        width="100%"
        cellPadding="0"
        border={0}
        style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}
      >
        <tbody style={{ width: '100%' }}>
          <tr style={{ width: '100%' }}>
            <TableCell index={0} props={blockProps} columns={columns} />
            <TableCell index={1} props={blockProps} columns={columns} />
            <TableCell index={2} props={blockProps} columns={columns} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

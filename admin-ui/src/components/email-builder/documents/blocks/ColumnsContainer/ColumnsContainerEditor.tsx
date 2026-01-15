

import { ColumnsContainer as BaseColumnsContainer } from '../../../blocks/ColumnsContainer';

import { useCurrentBlockId } from '../../editor/EditorBlock';
import { setDocument, setSelectedBlockId } from '../../editor/EditorContext';
import EditorChildrenIds, { EditorChildrenChange } from '../helpers/EditorChildrenIds';

import ColumnsContainerPropsSchema, { ColumnsContainerProps } from './ColumnsContainerPropsSchema';

type ColumnDef = { childrenIds: string[] };
const EMPTY_COLUMNS: [ColumnDef, ColumnDef, ColumnDef] = [{ childrenIds: [] }, { childrenIds: [] }, { childrenIds: [] }];

export default function ColumnsContainerEditor({ style, props }: ColumnsContainerProps) {
  const currentBlockId = useCurrentBlockId();

  const columns = props?.columns;
  const { columns: _, ...restProps } = props ?? {};
  const columnsValue: [ColumnDef, ColumnDef, ColumnDef] = (columns as [ColumnDef, ColumnDef, ColumnDef] | undefined) ?? EMPTY_COLUMNS;

  const updateColumn = (columnIndex: 0 | 1 | 2, { block, blockId, childrenIds }: EditorChildrenChange) => {
    const nColumns: [ColumnDef, ColumnDef, ColumnDef] = [...columnsValue];
    nColumns[columnIndex] = { childrenIds };
    setDocument({
      [blockId]: block,
      [currentBlockId]: {
        type: 'ColumnsContainer',
        data: ColumnsContainerPropsSchema.parse({
          style,
          props: {
            ...restProps,
            columns: nColumns,
          },
        }),
      },
    });
    setSelectedBlockId(blockId);
  };

  return (
    <BaseColumnsContainer
      props={restProps}
      style={style}
      columns={[
        <EditorChildrenIds childrenIds={columnsValue[0]?.childrenIds} onChange={(change) => updateColumn(0, change)} />,
        <EditorChildrenIds childrenIds={columnsValue[1]?.childrenIds} onChange={(change) => updateColumn(1, change)} />,
        <EditorChildrenIds childrenIds={columnsValue[2]?.childrenIds} onChange={(change) => updateColumn(2, change)} />,
      ]}
    />
  );
}

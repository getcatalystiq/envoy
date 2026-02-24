'use client';
import { ArrowDown, ArrowUp, Copy, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { TEditorBlock, TEditorConfiguration } from '../../../editor/core';
import { resetDocument, setSelectedBlockId, useDocument } from '../../../editor/EditorContext';
import { ColumnsContainerProps } from '../../ColumnsContainer/ColumnsContainerPropsSchema';
import cloneDocumentBlock from '../cloneDocumentBlock';

type ColumnItem = { childrenIds: string[] };

function findParentBlockId(blockId: string, document: TEditorConfiguration) {
  for (const [id, b] of Object.entries(document)) {
    if (id === blockId) {
      continue;
    }
    const block = b as TEditorBlock;
    switch (block.type) {
      case 'EmailLayout':
        if (block.data.childrenIds?.includes(blockId)) {
          return id;
        }
        break;
      case 'Container':
        if (block.data.props?.childrenIds?.includes(blockId)) {
          return id;
        }
        break;
      case 'ColumnsContainer':
        if (block.data.props?.columns?.some((col: ColumnItem) => col.childrenIds?.includes(blockId))) {
          return id;
        }
        break;
    }
  }
  return null;
}

type Props = {
  blockId: string;
};
export default function TuneMenu({ blockId }: Props) {
  const document = useDocument();

  const handleDuplicateClick = () => {
    const parentBlockId = findParentBlockId(blockId, document);

    const { document: newDocument, blockId: newBlockId } = cloneDocumentBlock(document, blockId);

    if (parentBlockId) {
      const parentBlock = newDocument[parentBlockId];
      switch (parentBlock.type) {
        case 'EmailLayout': {
          if (!parentBlock.data.childrenIds) {
            parentBlock.data.childrenIds = [];
          }
          const index = parentBlock.data.childrenIds.indexOf(blockId);
          parentBlock.data.childrenIds.splice(index + 1, 0, newBlockId);
          break;
        }
        case 'Container': {
          if (!parentBlock.data.props) {
            parentBlock.data.props = {};
          }
          if (!parentBlock.data.props.childrenIds) {
            parentBlock.data.props.childrenIds = [];
          }
          const index = parentBlock.data.props.childrenIds.indexOf(blockId);
          parentBlock.data.props.childrenIds.splice(index + 1, 0, newBlockId);
          break;
        }
        case 'ColumnsContainer':
          if (!parentBlock.data.props) {
            parentBlock.data.props = { columns: [{ childrenIds: [] }, { childrenIds: [] }, { childrenIds: [] }] };
          }

          for (const column of parentBlock.data.props.columns) {
            if (column.childrenIds.includes(blockId)) {
              const index = column.childrenIds.indexOf(blockId);
              column.childrenIds.splice(index + 1, 0, newBlockId);
            }
          }
          break;
      }

      resetDocument(newDocument);
      setSelectedBlockId(newBlockId);
    }
  };

  const handleDeleteClick = () => {
    const filterChildrenIds = (childrenIds: string[] | null | undefined) => {
      if (!childrenIds) {
        return childrenIds;
      }
      return childrenIds.filter((f) => f !== blockId);
    };
    const nDocument: typeof document = { ...document };
    for (const [id, b] of Object.entries(nDocument)) {
      const block = b as TEditorBlock;
      if (id === blockId) {
        continue;
      }

      switch (block.type) {
        case 'EmailLayout':
          nDocument[id] = {
            ...block,
            data: {
              ...block.data,
              childrenIds: filterChildrenIds(block.data.childrenIds),
            },
          };
          break;
        case 'Container':
          nDocument[id] = {
            ...block,
            data: {
              ...block.data,
              props: {
                ...block.data.props,
                childrenIds: filterChildrenIds(block.data.props?.childrenIds),
              },
            },
          };
          break;
        case 'ColumnsContainer':
          nDocument[id] = {
            type: 'ColumnsContainer',
            data: {
              style: block.data.style,
              props: {
                ...block.data.props,
                columns: block.data.props?.columns?.map((c: ColumnItem) => ({
                  childrenIds: filterChildrenIds(c.childrenIds),
                })),
              },
            } as ColumnsContainerProps,
          };
          break;
        default:
          nDocument[id] = block;
      }
    }
    delete nDocument[blockId];
    resetDocument(nDocument);
  };

  const handleMoveClick = (direction: 'up' | 'down') => {
    const moveChildrenIds = (ids: string[] | null | undefined) => {
      if (!ids) {
        return ids;
      }
      const index = ids.indexOf(blockId);
      if (index < 0) {
        return ids;
      }

      const childrenIds = [...ids];
      if (direction === 'up' && index > 0) {
        [childrenIds[index], childrenIds[index - 1]] = [childrenIds[index - 1], childrenIds[index]];
      } else if (direction === 'down' && index < childrenIds.length - 1) {
        [childrenIds[index], childrenIds[index + 1]] = [childrenIds[index + 1], childrenIds[index]];
      }
      return childrenIds;
    };

    const nDocument: typeof document = { ...document };
    for (const [id, b] of Object.entries(nDocument)) {
      const block = b as TEditorBlock;
      if (id === blockId) {
        continue;
      }

      switch (block.type) {
        case 'EmailLayout':
          nDocument[id] = {
            ...block,
            data: {
              ...block.data,
              childrenIds: moveChildrenIds(block.data.childrenIds),
            },
          };
          break;
        case 'Container':
          nDocument[id] = {
            ...block,
            data: {
              ...block.data,
              props: {
                ...block.data.props,
                childrenIds: moveChildrenIds(block.data.props?.childrenIds),
              },
            },
          };
          break;
        case 'ColumnsContainer':
          nDocument[id] = {
            type: 'ColumnsContainer',
            data: {
              style: block.data.style,
              props: {
                ...block.data.props,
                columns: block.data.props?.columns?.map((c: ColumnItem) => ({
                  childrenIds: moveChildrenIds(c.childrenIds),
                })),
              },
            } as ColumnsContainerProps,
          };
          break;
        default:
          nDocument[id] = block;
      }
    }

    resetDocument(nDocument);
    setSelectedBlockId(blockId);
  };

  return (
    <TooltipProvider>
      <div
        className="absolute top-0 -left-14 rounded-full px-1 py-2 z-50 bg-background shadow-md border border-border"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex flex-col">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleMoveClick('up')}>
                <ArrowUp className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Move up</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleMoveClick('down')}>
                <ArrowDown className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Move down</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleDuplicateClick}>
                <Copy className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Duplicate</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleDeleteClick}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}

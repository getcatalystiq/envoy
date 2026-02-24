'use client';
import { createContext, useContext, ReactNode } from 'react';
import { z } from 'zod';
import {
  buildBlockComponent,
  buildBlockConfigurationDictionary,
  buildBlockConfigurationSchema,
} from '../core';
import {
  Avatar, AvatarPropsSchema,
  Button, ButtonPropsSchema,
  Divider, DividerPropsSchema,
  Heading, HeadingPropsSchema,
  Html, HtmlPropsSchema,
  Image, ImagePropsSchema,
  Spacer, SpacerPropsSchema,
  Text, TextPropsSchema,
  Container,
  ColumnsContainer,
  ColumnsContainerPropsSchema,
} from '../blocks';
import { EmailLayoutReader, EmailLayoutPropsSchema } from './EmailLayout';

// Extended ContainerPropsSchema with childrenIds for Reader
const ContainerReaderPropsSchema = z.object({
  style: z.object({
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    borderColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    borderRadius: z.number().optional().nullable(),
    padding: z.object({
      top: z.number(),
      bottom: z.number(),
      right: z.number(),
      left: z.number(),
    }).optional().nullable(),
  }).optional().nullable(),
  props: z.object({
    childrenIds: z.array(z.string()).optional().nullable(),
  }).optional().nullable(),
});

// Extended ColumnsContainerPropsSchema with childrenIds for Reader
const ColumnsContainerReaderPropsSchema = z.object({
  style: ColumnsContainerPropsSchema.shape.style,
  props: z.object({
    columns: z.tuple([
      z.object({ childrenIds: z.array(z.string()) }),
      z.object({ childrenIds: z.array(z.string()) }),
      z.object({ childrenIds: z.array(z.string()) }),
    ]),
    fixedWidths: z.tuple([z.number().nullish(), z.number().nullish(), z.number().nullish()]).optional().nullable(),
    columnsCount: z.union([z.literal(2), z.literal(3)]).optional().nullable(),
    columnsGap: z.number().optional().nullable(),
    contentAlignment: z.enum(['top', 'middle', 'bottom']).optional().nullable(),
  }).optional().nullable(),
});

// Reader Document type - flat object with block IDs as keys
export type TReaderDocument = Record<string, TReaderBlock>;

export type TReaderBlock = {
  type: string;
  data: Record<string, unknown>;
};

// Context for sharing document across components
const ReaderContext = createContext<TReaderDocument>({});

export function useReaderDocument(): TReaderDocument {
  return useContext(ReaderContext);
}

// Build the reader dictionary with all block types
// Note: Container/ColumnsContainer/EmailLayout readers are defined inline
// to handle the recursive ReaderBlock rendering
const READER_DICTIONARY = buildBlockConfigurationDictionary({
  ColumnsContainer: {
    schema: ColumnsContainerReaderPropsSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Component: (componentProps: any) => {
      const { style, props } = componentProps as z.infer<typeof ColumnsContainerReaderPropsSchema>;
      const { columns, ...restProps } = props ?? { columns: undefined };

      let cols: ReactNode[] | undefined = undefined;
      if (columns) {
        cols = columns.map((col) =>
          col.childrenIds.map((childId) => <ReaderBlock key={childId} id={childId} />)
        );
      }

      return <ColumnsContainer props={restProps} columns={cols} style={style} />;
    },
  },
  Container: {
    schema: ContainerReaderPropsSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Component: (componentProps: any) => {
      const { style, props } = componentProps as z.infer<typeof ContainerReaderPropsSchema>;
      const childrenIds = props?.childrenIds ?? [];
      return (
        <Container style={style}>
          {childrenIds.map((childId) => (
            <ReaderBlock key={childId} id={childId} />
          ))}
        </Container>
      );
    },
  },
  EmailLayout: {
    schema: EmailLayoutPropsSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Component: (componentProps: any) => {
      const props = componentProps as z.infer<typeof EmailLayoutPropsSchema>;
      const childrenIds = props.childrenIds ?? [];
      return (
        <EmailLayoutReader {...props}>
          {childrenIds.map((childId) => (
            <ReaderBlock key={childId} id={childId} />
          ))}
        </EmailLayoutReader>
      );
    },
  },
  Avatar: {
    schema: AvatarPropsSchema,
    Component: Avatar,
  },
  Button: {
    schema: ButtonPropsSchema,
    Component: Button,
  },
  Divider: {
    schema: DividerPropsSchema,
    Component: Divider,
  },
  Heading: {
    schema: HeadingPropsSchema,
    Component: Heading,
  },
  Html: {
    schema: HtmlPropsSchema,
    Component: Html,
  },
  Image: {
    schema: ImagePropsSchema,
    Component: Image,
  },
  Spacer: {
    schema: SpacerPropsSchema,
    Component: Spacer,
  },
  Text: {
    schema: TextPropsSchema,
    Component: Text,
  },
});

export const ReaderBlockSchema = buildBlockConfigurationSchema(READER_DICTIONARY);
export const ReaderDocumentSchema = z.record(z.string(), ReaderBlockSchema);

const BaseReaderBlock = buildBlockComponent(READER_DICTIONARY);

export function ReaderBlock({ id }: { id: string }): JSX.Element {
  const document = useReaderDocument();
  const block = document[id];
  if (!block) {
    return <></>;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <BaseReaderBlock {...(block as any)} />;
}

interface ReaderProps {
  document: TReaderDocument;
  rootBlockId: string;
}

export function Reader({ document, rootBlockId }: ReaderProps) {
  return (
    <ReaderContext.Provider value={document}>
      <ReaderBlock id={rootBlockId} />
    </ReaderContext.Provider>
  );
}

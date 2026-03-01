'use client';
import { z } from 'zod';

import {
  Avatar, AvatarPropsSchema,
  ButtonPropsSchema,
  Divider, DividerPropsSchema,
  HeadingPropsSchema,
  HtmlPropsSchema,
  Image, ImagePropsSchema,
  Spacer, SpacerPropsSchema,
  TextPropsSchema,
} from '../../blocks';
import {
  buildBlockComponent,
  buildBlockConfigurationDictionary,
  buildBlockConfigurationSchema,
} from '../../core';

import ButtonEditor from '../blocks/Button/ButtonEditor';
import ColumnsContainerEditor from '../blocks/ColumnsContainer/ColumnsContainerEditor';
import ColumnsContainerPropsSchema from '../blocks/ColumnsContainer/ColumnsContainerPropsSchema';
import ContainerEditor from '../blocks/Container/ContainerEditor';
import ContainerPropsSchema from '../blocks/Container/ContainerPropsSchema';
import EmailLayoutEditor from '../blocks/EmailLayout/EmailLayoutEditor';
import EmailLayoutPropsSchema from '../blocks/EmailLayout/EmailLayoutPropsSchema';
import HeadingEditor from '../blocks/Heading/HeadingEditor';
import HtmlEditor from '../blocks/Html/HtmlEditor';
import TextEditor from '../blocks/Text/TextEditor';
import EditorBlockWrapper from '../blocks/helpers/block-wrappers/EditorBlockWrapper';

const EDITOR_DICTIONARY = buildBlockConfigurationDictionary({
  Avatar: {
    schema: AvatarPropsSchema,
    Component: (props) => (
      <EditorBlockWrapper>
        <Avatar {...props} />
      </EditorBlockWrapper>
    ),
  },
  Button: {
    schema: ButtonPropsSchema,
    Component: (props) => (
      <EditorBlockWrapper>
        <ButtonEditor {...props} />
      </EditorBlockWrapper>
    ),
  },
  Container: {
    schema: ContainerPropsSchema,
    Component: (props) => (
      <EditorBlockWrapper>
        <ContainerEditor {...props} />
      </EditorBlockWrapper>
    ),
  },
  ColumnsContainer: {
    schema: ColumnsContainerPropsSchema,
    Component: (props) => (
      <EditorBlockWrapper>
        <ColumnsContainerEditor {...props} />
      </EditorBlockWrapper>
    ),
  },
  Heading: {
    schema: HeadingPropsSchema,
    Component: (props) => (
      <EditorBlockWrapper>
        <HeadingEditor {...props} />
      </EditorBlockWrapper>
    ),
  },
  Html: {
    schema: HtmlPropsSchema,
    Component: (props) => (
      <EditorBlockWrapper>
        <HtmlEditor {...props} />
      </EditorBlockWrapper>
    ),
  },
  Image: {
    schema: ImagePropsSchema,
    Component: (data) => {
      const props = {
        ...data,
        props: {
          ...data.props,
          url: data.props?.url ?? 'https://placehold.co/600x400@2x/F8F8F8/CCC?text=Your%20image',
        },
      };
      return (
        <EditorBlockWrapper>
          <Image {...props} />
        </EditorBlockWrapper>
      );
    },
  },
  Text: {
    schema: TextPropsSchema,
    Component: (props) => (
      <EditorBlockWrapper>
        <TextEditor {...props} />
      </EditorBlockWrapper>
    ),
  },
  EmailLayout: {
    schema: EmailLayoutPropsSchema,
    Component: (p) => <EmailLayoutEditor {...p} />,
  },
  Spacer: {
    schema: SpacerPropsSchema,
    Component: (props) => (
      <EditorBlockWrapper>
        <Spacer {...props} />
      </EditorBlockWrapper>
    ),
  },
  Divider: {
    schema: DividerPropsSchema,
    Component: (props) => (
      <EditorBlockWrapper>
        <Divider {...props} />
      </EditorBlockWrapper>
    ),
  },
});

export const EditorBlock = buildBlockComponent(EDITOR_DICTIONARY);
export const EditorBlockSchema = buildBlockConfigurationSchema(EDITOR_DICTIONARY);
export const EditorConfigurationSchema = z.record(z.string(), EditorBlockSchema);

export type TEditorBlock = z.infer<typeof EditorBlockSchema>;
export type TEditorConfiguration = Record<string, TEditorBlock>;

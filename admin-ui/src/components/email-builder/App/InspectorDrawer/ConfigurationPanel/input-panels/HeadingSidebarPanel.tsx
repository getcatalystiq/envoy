import { useState } from 'react';
import { ToggleGroupItem } from '@/components/ui/toggle-group';
import { HeadingProps, HeadingPropsDefaults, HeadingPropsSchema } from '../../../../blocks';

import BaseSidebarPanel from './helpers/BaseSidebarPanel';
import RadioGroupInput from './helpers/inputs/RadioGroupInput';
import TextInput from './helpers/inputs/TextInput';
import PersonalizationInput from './helpers/inputs/PersonalizationInput';
import MultiStylePropertyPanel from './helpers/style-inputs/MultiStylePropertyPanel';

type HeadingSidebarPanelProps = {
  data: HeadingProps;
  setData: (v: HeadingProps) => void;
  showPersonalization?: boolean;
};

export default function HeadingSidebarPanel({ data, setData, showPersonalization }: HeadingSidebarPanelProps) {
  const [, setErrors] = useState<Zod.ZodError | null>(null);

  const updateData = (d: unknown) => {
    const res = HeadingPropsSchema.safeParse(d);
    if (res.success) {
      setData(res.data);
      setErrors(null);
    } else {
      setErrors(res.error);
    }
  };

  return (
    <BaseSidebarPanel title="Heading block">
      <TextInput
        label="Content"
        rows={3}
        defaultValue={data.props?.text ?? HeadingPropsDefaults.text}
        onChange={(text) => {
          updateData({ ...data, props: { ...data.props, text } });
        }}
      />
      <RadioGroupInput
        label="Level"
        defaultValue={data.props?.level ?? HeadingPropsDefaults.level}
        onChange={(level) => {
          updateData({ ...data, props: { ...data.props, level } });
        }}
      >
        <ToggleGroupItem value="h1" className="flex-1">
          H1
        </ToggleGroupItem>
        <ToggleGroupItem value="h2" className="flex-1">
          H2
        </ToggleGroupItem>
        <ToggleGroupItem value="h3" className="flex-1">
          H3
        </ToggleGroupItem>
      </RadioGroupInput>

      {showPersonalization && <PersonalizationInput />}

      <MultiStylePropertyPanel
        names={['color', 'backgroundColor', 'fontFamily', 'fontWeight', 'textAlign', 'padding']}
        value={data.style}
        onChange={(style) => updateData({ ...data, style })}
      />
    </BaseSidebarPanel>
  );
}

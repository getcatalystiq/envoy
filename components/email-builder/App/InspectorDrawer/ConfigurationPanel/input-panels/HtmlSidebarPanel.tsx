'use client';
import { useState } from 'react';

import { HtmlProps, HtmlPropsSchema } from '../../../../blocks';

import BaseSidebarPanel from './helpers/BaseSidebarPanel';
import PersonalizationInput from './helpers/inputs/PersonalizationInput';
import MultiStylePropertyPanel from './helpers/style-inputs/MultiStylePropertyPanel';

type HtmlSidebarPanelProps = {
  data: HtmlProps;
  setData: (v: HtmlProps) => void;
  showPersonalization?: boolean;
};
export default function HtmlSidebarPanel({ data, setData, showPersonalization }: HtmlSidebarPanelProps) {
  const [, setErrors] = useState<Zod.ZodError | null>(null);

  const updateData = (d: unknown) => {
    const res = HtmlPropsSchema.safeParse(d);
    if (res.success) {
      setData(res.data);
      setErrors(null);
    } else {
      setErrors(res.error);
    }
  };

  return (
    <BaseSidebarPanel title="Html block">
      {showPersonalization && <PersonalizationInput />}

      <MultiStylePropertyPanel
        names={['backgroundColor', 'fontFamily', 'fontSize', 'padding']}
        value={data.style}
        onChange={(style) => updateData({ ...data, style })}
      />
    </BaseSidebarPanel>
  );
}

'use client';
import { useState } from 'react';
import { Space, AlignStartVertical, AlignCenterVertical, AlignEndVertical } from 'lucide-react';
import { ToggleGroupItem } from '@/components/ui/toggle-group';

import ColumnsContainerPropsSchema, {
  ColumnsContainerProps,
} from '../../../../documents/blocks/ColumnsContainer/ColumnsContainerPropsSchema';

import BaseSidebarPanel from './helpers/BaseSidebarPanel';
import ColumnWidthsInput from './helpers/inputs/ColumnWidthsInput';
import RadioGroupInput from './helpers/inputs/RadioGroupInput';
import SliderInput from './helpers/inputs/SliderInput';
import MultiStylePropertyPanel from './helpers/style-inputs/MultiStylePropertyPanel';

type ColumnsContainerPanelProps = {
  data: ColumnsContainerProps;
  setData: (v: ColumnsContainerProps) => void;
};

export default function ColumnsContainerPanel({ data, setData }: ColumnsContainerPanelProps) {
  const [, setErrors] = useState<Zod.ZodError | null>(null);
  const updateData = (d: unknown) => {
    const res = ColumnsContainerPropsSchema.safeParse(d);
    if (res.success) {
      setData(res.data);
      setErrors(null);
    } else {
      setErrors(res.error);
    }
  };

  return (
    <BaseSidebarPanel title="Columns block">
      <RadioGroupInput
        label="Number of columns"
        defaultValue={data.props?.columnsCount === 2 ? '2' : '3'}
        onChange={(v) => {
          updateData({ ...data, props: { ...data.props, columnsCount: v === '2' ? 2 : 3 } });
        }}
      >
        <ToggleGroupItem value="2" className="flex-1">
          2
        </ToggleGroupItem>
        <ToggleGroupItem value="3" className="flex-1">
          3
        </ToggleGroupItem>
      </RadioGroupInput>
      <ColumnWidthsInput
        defaultValue={
          data.props?.fixedWidths as
            | [number | null | undefined, number | null | undefined, number | null | undefined]
            | null
            | undefined
        }
        onChange={(fixedWidths) => {
          updateData({ ...data, props: { ...data.props, fixedWidths } });
        }}
      />
      <SliderInput
        label="Columns gap"
        iconLabel={<Space className="h-4 w-4 text-muted-foreground" />}
        units="px"
        step={4}
        marks
        min={0}
        max={80}
        defaultValue={(data.props?.columnsGap as number | undefined) ?? 0}
        onChange={(columnsGap) => updateData({ ...data, props: { ...data.props, columnsGap } })}
      />
      <RadioGroupInput
        label="Alignment"
        defaultValue={(data.props?.contentAlignment as string | undefined) ?? 'middle'}
        onChange={(contentAlignment) => {
          updateData({ ...data, props: { ...data.props, contentAlignment } });
        }}
      >
        <ToggleGroupItem value="top" className="flex-1">
          <AlignStartVertical className="h-4 w-4" />
        </ToggleGroupItem>
        <ToggleGroupItem value="middle" className="flex-1">
          <AlignCenterVertical className="h-4 w-4" />
        </ToggleGroupItem>
        <ToggleGroupItem value="bottom" className="flex-1">
          <AlignEndVertical className="h-4 w-4" />
        </ToggleGroupItem>
      </RadioGroupInput>

      <MultiStylePropertyPanel
        names={['backgroundColor', 'padding']}
        value={data.style}
        onChange={(style) => updateData({ ...data, style })}
      />
    </BaseSidebarPanel>
  );
}

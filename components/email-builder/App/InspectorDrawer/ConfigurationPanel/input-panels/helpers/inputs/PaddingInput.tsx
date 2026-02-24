'use client';
import { useState } from 'react';
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from 'lucide-react';
import { Label } from '@/components/ui/label';
import RawSliderInput from './raw/RawSliderInput';

type TPaddingValue = {
  top: number;
  bottom: number;
  right: number;
  left: number;
};

type Props = {
  label: string;
  defaultValue: TPaddingValue | null;
  onChange: (value: TPaddingValue) => void;
};

export default function PaddingInput({ label, defaultValue, onChange }: Props) {
  const [value, setValue] = useState(() => {
    if (defaultValue) {
      return defaultValue;
    }
    return {
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
    };
  });

  function handleChange(internalName: keyof TPaddingValue, nValue: number) {
    const v = {
      ...value,
      [internalName]: nValue,
    };
    setValue(v);
    onChange(v);
  }

  return (
    <div className="flex flex-col gap-2 items-start pb-1">
      <Label className="text-xs">{label}</Label>

      <RawSliderInput
        iconLabel={<ArrowUp className="h-4 w-4 text-muted-foreground" />}
        value={value.top}
        setValue={(num) => handleChange('top', num)}
        units="px"
        step={4}
        min={0}
        max={80}
      />

      <RawSliderInput
        iconLabel={<ArrowDown className="h-4 w-4 text-muted-foreground" />}
        value={value.bottom}
        setValue={(num) => handleChange('bottom', num)}
        units="px"
        step={4}
        min={0}
        max={80}
      />

      <RawSliderInput
        iconLabel={<ArrowLeft className="h-4 w-4 text-muted-foreground" />}
        value={value.left}
        setValue={(num) => handleChange('left', num)}
        units="px"
        step={4}
        min={0}
        max={80}
      />

      <RawSliderInput
        iconLabel={<ArrowRight className="h-4 w-4 text-muted-foreground" />}
        value={value.right}
        setValue={(num) => handleChange('right', num)}
        units="px"
        step={4}
        min={0}
        max={80}
      />
    </div>
  );
}

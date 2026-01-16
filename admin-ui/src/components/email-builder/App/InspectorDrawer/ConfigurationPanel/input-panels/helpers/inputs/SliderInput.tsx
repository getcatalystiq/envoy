import { useState } from 'react';
import { Label } from '@/components/ui/label';
import RawSliderInput from './raw/RawSliderInput';

type SliderInputProps = {
  label: string;
  iconLabel: JSX.Element;
  step?: number;
  marks?: boolean;
  units: string;
  min?: number;
  max?: number;
  defaultValue: number;
  onChange: (v: number) => void;
};

export default function SliderInput({ label, defaultValue, onChange, ...props }: SliderInputProps) {
  const [value, setValue] = useState(defaultValue);
  return (
    <div className="flex flex-col gap-1 items-start">
      <Label className="text-xs">{label}</Label>
      <RawSliderInput
        value={value}
        setValue={(value: number) => {
          setValue(value);
          onChange(value);
        }}
        {...props}
      />
    </div>
  );
}

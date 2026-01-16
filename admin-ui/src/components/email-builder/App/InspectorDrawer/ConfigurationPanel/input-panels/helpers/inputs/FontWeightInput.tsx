import { useState } from 'react';
import { ToggleGroupItem } from '@/components/ui/toggle-group';
import RadioGroupInput from './RadioGroupInput';

type Props = {
  label: string;
  defaultValue: string;
  onChange: (value: string) => void;
};

export default function FontWeightInput({ label, defaultValue, onChange }: Props) {
  const [value, setValue] = useState(defaultValue);
  return (
    <RadioGroupInput
      label={label}
      defaultValue={value}
      onChange={(fontWeight) => {
        setValue(fontWeight);
        onChange(fontWeight);
      }}
    >
      <ToggleGroupItem value="normal" className="flex-1">
        Regular
      </ToggleGroupItem>
      <ToggleGroupItem value="bold" className="flex-1">
        Bold
      </ToggleGroupItem>
    </RadioGroupInput>
  );
}

import { useState } from 'react';
import { AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import { ToggleGroupItem } from '@/components/ui/toggle-group';
import RadioGroupInput from './RadioGroupInput';

type Props = {
  label: string;
  defaultValue: string | null;
  onChange: (value: string | null) => void;
};

export default function TextAlignInput({ label, defaultValue, onChange }: Props) {
  const [value, setValue] = useState(defaultValue ?? 'left');

  return (
    <RadioGroupInput
      label={label}
      defaultValue={value}
      onChange={(value) => {
        setValue(value);
        onChange(value);
      }}
    >
      <ToggleGroupItem value="left" className="flex-1">
        <AlignLeft className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="center" className="flex-1">
        <AlignCenter className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="right" className="flex-1">
        <AlignRight className="h-4 w-4" />
      </ToggleGroupItem>
    </RadioGroupInput>
  );
}

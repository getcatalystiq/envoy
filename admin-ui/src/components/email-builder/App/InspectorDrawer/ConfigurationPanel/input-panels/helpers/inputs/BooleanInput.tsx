import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

type Props = {
  label: string;
  defaultValue: boolean;
  onChange: (value: boolean) => void;
};

export default function BooleanInput({ label, defaultValue, onChange }: Props) {
  const [value, setValue] = useState(defaultValue);
  return (
    <div className="flex items-center space-x-2">
      <Switch
        id={`switch-${label}`}
        checked={value}
        onCheckedChange={(checked: boolean) => {
          setValue(checked);
          onChange(checked);
        }}
      />
      <Label htmlFor={`switch-${label}`}>{label}</Label>
    </div>
  );
}

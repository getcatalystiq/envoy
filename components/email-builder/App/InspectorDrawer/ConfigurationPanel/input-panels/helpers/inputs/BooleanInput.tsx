'use client';
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useReadOnly } from '../../../../../../documents/editor/EditorContext';

type Props = {
  label: string;
  defaultValue: boolean;
  onChange: (value: boolean) => void;
};

export default function BooleanInput({ label, defaultValue, onChange }: Props) {
  const [value, setValue] = useState(defaultValue);
  const readOnly = useReadOnly();

  return (
    <div className={`flex items-center space-x-2 ${readOnly ? 'pointer-events-none opacity-60' : ''}`}>
      <Switch
        id={`switch-${label}`}
        checked={value}
        onCheckedChange={(checked: boolean) => {
          if (readOnly) return;
          setValue(checked);
          onChange(checked);
        }}
      />
      <Label htmlFor={`switch-${label}`}>{label}</Label>
    </div>
  );
}

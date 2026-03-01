'use client';
import { useState } from 'react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { FONT_FAMILIES } from '../../../../../../documents/blocks/helpers/fontFamily';
import { useReadOnly } from '../../../../../../documents/editor/EditorContext';

type NullableProps = {
  label: string;
  onChange: (value: null | string) => void;
  defaultValue: null | string;
};

export function NullableFontFamily({ label, onChange, defaultValue }: NullableProps) {
  const [value, setValue] = useState(defaultValue ?? 'inherit');
  const readOnly = useReadOnly();

  return (
    <div className={`flex flex-col gap-1.5 ${readOnly ? 'pointer-events-none opacity-60' : ''}`}>
      <Label className="text-xs">{label}</Label>
      <Select
        value={value}
        onValueChange={(v) => {
          if (readOnly) return;
          setValue(v);
          onChange(v === 'inherit' ? null : v);
        }}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select font" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">Match email settings</SelectItem>
          {FONT_FAMILIES.map((option) => (
            <SelectItem
              key={option.key}
              value={option.key}
              style={{ fontFamily: option.value }}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

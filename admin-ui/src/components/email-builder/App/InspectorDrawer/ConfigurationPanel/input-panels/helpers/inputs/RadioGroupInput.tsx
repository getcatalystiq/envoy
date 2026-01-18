import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { useReadOnly } from '../../../../../../documents/editor/EditorContext';

type Props = {
  label: string | JSX.Element;
  children: JSX.Element | JSX.Element[];
  defaultValue: string;
  onChange: (v: string) => void;
};

export default function RadioGroupInput({ label, children, defaultValue, onChange }: Props) {
  const [value, setValue] = useState(defaultValue);
  const readOnly = useReadOnly();

  return (
    <div className="flex flex-col items-start gap-1">
      <Label className="text-xs">{label}</Label>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v: string) => {
          if (readOnly) return;
          if (!v) return; // Don't allow deselection
          setValue(v);
          onChange(v);
        }}
        className={`w-full ${readOnly ? 'pointer-events-none opacity-60' : ''}`}
      >
        {children}
      </ToggleGroup>
    </div>
  );
}

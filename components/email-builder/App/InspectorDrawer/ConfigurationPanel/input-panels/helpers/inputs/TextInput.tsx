'use client';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useReadOnly } from '../../../../../../documents/editor/EditorContext';

type Props = {
  label: string;
  rows?: number;
  placeholder?: string;
  helperText?: string | JSX.Element;
  defaultValue: string;
  onChange: (v: string) => void;
};

export default function TextInput({
  helperText,
  label,
  placeholder,
  rows,
  defaultValue,
  onChange,
}: Props) {
  const [value, setValue] = useState(defaultValue);
  const readOnly = useReadOnly();
  const isMultiline = typeof rows === 'number' && rows > 1;

  // In read-only mode, show full content in a styled div
  if (readOnly) {
    return (
      <div className="flex flex-col gap-1.5 w-full">
        <Label className="text-xs">{label}</Label>
        <div className="text-sm whitespace-pre-wrap break-words min-h-[2.5rem] p-2 bg-muted rounded-md border border-input">
          {value || <span className="text-muted-foreground">{placeholder || 'Empty'}</span>}
        </div>
        {helperText && <p className="text-xs text-muted-foreground">{helperText}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <Label className="text-xs">{label}</Label>
      {isMultiline ? (
        <Textarea
          placeholder={placeholder}
          value={value}
          rows={rows}
          onChange={(ev) => {
            const v = ev.target.value;
            setValue(v);
            onChange(v);
          }}
        />
      ) : (
        <Input
          placeholder={placeholder}
          value={value}
          onChange={(ev) => {
            const v = ev.target.value;
            setValue(v);
            onChange(v);
          }}
        />
      )}
      {helperText && <p className="text-xs text-muted-foreground">{helperText}</p>}
    </div>
  );
}

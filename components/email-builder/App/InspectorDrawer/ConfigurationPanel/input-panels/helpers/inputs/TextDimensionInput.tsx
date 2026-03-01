'use client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useReadOnly } from '../../../../../../documents/editor/EditorContext';

type TextDimensionInputProps = {
  label: string;
  defaultValue: number | null | undefined;
  onChange: (v: number | null) => void;
};

export default function TextDimensionInput({
  label,
  defaultValue,
  onChange,
}: TextDimensionInputProps) {
  const readOnly = useReadOnly();

  const handleChange: React.ChangeEventHandler<HTMLInputElement> = (ev) => {
    if (readOnly) return;
    const value = parseInt(ev.target.value);
    onChange(isNaN(value) ? null : value);
  };

  return (
    <div className={`flex flex-col gap-1.5 w-full ${readOnly ? 'pointer-events-none opacity-60' : ''}`}>
      <Label className="text-xs">{label}</Label>
      <div className="relative">
        <Input
          onChange={handleChange}
          defaultValue={defaultValue ?? ''}
          placeholder="auto"
          className="pr-8"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          px
        </span>
      </div>
    </div>
  );
}

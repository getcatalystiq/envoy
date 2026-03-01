'use client';
import { cn } from '@/lib/utils';

type Props = {
  paletteColors: string[];
  value: string;
  onChange: (value: string) => void;
};

export default function Swatch({ paletteColors, value, onChange }: Props) {
  const renderButton = (colorValue: string) => {
    return (
      <button
        key={colorValue}
        type="button"
        onClick={() => onChange(colorValue)}
        className={cn(
          'w-6 h-6 rounded border inline-flex hover:border-border transition-colors',
          value === colorValue ? 'border-black' : 'border-border'
        )}
        style={{ backgroundColor: colorValue }}
      />
    );
  };
  return (
    <div className="w-full grid gap-1 grid-cols-6">
      {paletteColors.map((c) => renderButton(c))}
    </div>
  );
}

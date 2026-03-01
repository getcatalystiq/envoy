'use client';
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useReadOnly } from '../../../../../../../documents/editor/EditorContext';
import Picker from './Picker';

type Props =
  | {
      nullable: true;
      label: string;
      onChange: (value: string | null) => void;
      defaultValue: string | null;
    }
  | {
      nullable: false;
      label: string;
      onChange: (value: string) => void;
      defaultValue: string;
    };

export default function ColorInput({ label, defaultValue, onChange, nullable }: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(defaultValue);
  const readOnly = useReadOnly();

  const renderResetButton = () => {
    if (readOnly) return null;
    if (!nullable) {
      return null;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      return null;
    }
    return (
      <button
        type="button"
        onClick={() => {
          setValue(null);
          onChange(null);
        }}
        className="p-1 hover:bg-gray-100 rounded"
      >
        <X className="h-4 w-4 text-gray-600" />
      </button>
    );
  };

  const renderColorSwatch = () => {
    if (value) {
      return (
        <div
          className={`w-8 h-8 rounded border border-gray-300 ${readOnly ? 'opacity-60' : ''}`}
          style={{ backgroundColor: value }}
        />
      );
    }
    return (
      <div className={`w-8 h-8 rounded border border-gray-300 bg-white flex items-center justify-center ${readOnly ? 'opacity-60' : ''}`}>
        <Plus className="h-4 w-4" />
      </div>
    );
  };

  const renderOpenButton = () => {
    if (value) {
      return (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-8 h-8 rounded border border-gray-300"
          style={{ backgroundColor: value }}
        />
      );
    }
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-8 h-8 rounded border border-gray-300 bg-white flex items-center justify-center"
      >
        <Plus className="h-4 w-4" />
      </button>
    );
  };

  // In read-only mode, just show the color swatch without interaction
  if (readOnly) {
    return (
      <div className="flex flex-col items-start">
        <Label className="text-xs mb-0.5">{label}</Label>
        <div className="flex flex-row gap-1">
          {renderColorSwatch()}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start">
      <Label className="text-xs mb-0.5">{label}</Label>
      <div className="flex flex-row gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{renderOpenButton()}</PopoverTrigger>
          <PopoverContent className="w-auto p-0">
            <Picker
              value={value || ''}
              onChange={(v) => {
                setValue(v);
                onChange(v);
              }}
            />
          </PopoverContent>
        </Popover>
        {renderResetButton()}
      </div>
    </div>
  );
}

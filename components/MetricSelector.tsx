'use client';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export interface MetricOption {
  id: string;
  label: string;
  color: string;
}

interface MetricSelectorProps {
  metrics: MetricOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

export function MetricSelector({
  metrics,
  selected,
  onChange,
}: MetricSelectorProps) {
  const [open, setOpen] = useState(false);

  const toggleMetric = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  const selectAll = () => onChange(metrics.map((m) => m.id));
  const clearAll = () => onChange([]);

  const allSelected = selected.length === metrics.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-[180px] justify-between font-normal"
        >
          {selected.length === 0
            ? 'Select metrics'
            : selected.length === metrics.length
              ? 'All metrics'
              : `${selected.length} selected`}
          <ChevronDown
            className={`ml-2 h-4 w-4 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" align="start">
        <div className="border-b p-2">
          <label className="flex cursor-pointer items-center gap-2 rounded p-2 hover:bg-muted">
            <Checkbox
              checked={allSelected}
              onCheckedChange={() => (allSelected ? clearAll() : selectAll())}
            />
            <span className="text-sm font-medium">Select all</span>
          </label>
        </div>
        <div className="max-h-[300px] overflow-auto p-2">
          {metrics.map((metric) => (
            <label
              key={metric.id}
              className="flex cursor-pointer items-center gap-2 rounded p-2 hover:bg-muted"
            >
              <Checkbox
                checked={selected.includes(metric.id)}
                onCheckedChange={() => toggleMetric(metric.id)}
              />
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: metric.color }}
              />
              <span className="text-sm">{metric.label}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

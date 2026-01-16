import { Slider } from '@/components/ui/slider';

type SliderInputProps = {
  iconLabel: JSX.Element;
  step?: number;
  marks?: boolean;
  units: string;
  min?: number;
  max?: number;
  value: number;
  setValue: (v: number) => void;
};

export default function RawSliderInput({
  iconLabel,
  value,
  setValue,
  units,
  step = 1,
  min = 0,
  max = 100,
}: SliderInputProps) {
  return (
    <div className="flex flex-row items-center gap-2 justify-between w-full">
      <div className="min-w-6 leading-none flex-shrink-0">{iconLabel}</div>
      <Slider
        value={[value]}
        onValueChange={(values) => {
          setValue(values[0]);
        }}
        step={step}
        min={min}
        max={max}
        className="flex-1"
      />
      <div className="min-w-8 text-right flex-shrink-0">
        <span className="text-xs text-muted-foreground leading-none">
          {value}
          {units}
        </span>
      </div>
    </div>
  );
}

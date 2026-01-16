import { Plus } from 'lucide-react';

type Props = {
  onClick: () => void;
};

export default function PlaceholderButton({ onClick }: Props) {
  return (
    <button
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
      className="flex items-center justify-center h-12 w-full bg-black/5"
    >
      <span className="p-0.5 bg-primary rounded-full text-primary-foreground">
        <Plus className="h-4 w-4" />
      </span>
    </button>
  );
}

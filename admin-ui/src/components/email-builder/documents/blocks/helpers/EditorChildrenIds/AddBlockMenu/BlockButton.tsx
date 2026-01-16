import { Button } from '@/components/ui/button';

type BlockMenuButtonProps = {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
};

export default function BlockTypeButton({ label, icon, onClick }: BlockMenuButtonProps) {
  return (
    <Button
      variant="ghost"
      className="p-3 flex flex-col h-auto"
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
    >
      <div className="mb-1.5 w-full bg-muted flex justify-center p-2 border border-border rounded">
        {icon}
      </div>
      <span className="text-sm">{label}</span>
    </Button>
  );
}

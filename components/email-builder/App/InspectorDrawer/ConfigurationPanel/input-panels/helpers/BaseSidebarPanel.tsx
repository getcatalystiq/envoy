'use client';
type SidebarPanelProps = {
  title: string;
  children: React.ReactNode;
};

export default function BaseSidebarPanel({ title, children }: SidebarPanelProps) {
  return (
    <div className="p-4">
      <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium block mb-4">
        {title}
      </span>
      <div className="flex flex-col gap-5 mb-3">{children}</div>
    </div>
  );
}

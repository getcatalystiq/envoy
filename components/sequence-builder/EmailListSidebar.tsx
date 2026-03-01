'use client';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Clock, GripVertical, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Reader, type TReaderDocument } from '../email-builder/Reader';

export interface SequenceEmail {
  id: string;
  subject: string;
  delay: string;
  hasUnpublishedChanges?: boolean;
  builderContent?: TReaderDocument | null;
}

// Preview component for minified email template
function EmailPreview({ document }: { document: TReaderDocument }) {
  const hasContent = document && Object.keys(document).length > 0 && document.root;

  if (!hasContent) {
    return (
      <div className="w-full h-[140px] bg-muted rounded-md flex items-center justify-center">
        <span className="text-xs text-muted-foreground">No preview</span>
      </div>
    );
  }

  return (
    <div className="w-full h-[140px] overflow-hidden rounded-md border border-border bg-background relative">
      <div
        className="absolute inset-0 origin-top-left pointer-events-none"
        style={{
          transform: 'scale(0.35)',
          width: '285.7%', // 1/0.35 = ~2.857
          height: '285.7%',
        }}
      >
        <Reader document={document} rootBlockId="root" />
      </div>
    </div>
  );
}

interface EmailItemProps {
  email: SequenceEmail;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
  canEdit: boolean;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  dragOverIndex: number | null;
}

function EmailItem({
  email,
  index,
  isSelected,
  onSelect,
  canEdit,
  onDragStart,
  onDragOver,
  onDragEnd,
  isDragging,
  dragOverIndex,
}: EmailItemProps) {
  return (
    <div
      draggable={canEdit}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(index);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver(index);
      }}
      onDrop={(e) => {
        e.preventDefault();
      }}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      className={cn(
        'bg-background rounded-lg border cursor-pointer transition-all overflow-hidden',
        'hover:border-border',
        isSelected && 'ring-2 ring-primary border-primary',
        isDragging && 'opacity-50',
        dragOverIndex === index && 'border-primary border-2'
      )}
    >
      {/* Preview Section - Always show */}
      <div className="p-3 pb-2">
        <EmailPreview document={email.builderContent || {}} />
      </div>

      {/* Info Section */}
      <div className="px-3 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-foreground truncate text-sm">
              {email.subject || 'Untitled Email'}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <Clock className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              <span className="text-xs text-muted-foreground">{email.delay}</span>
              {email.hasUnpublishedChanges && (
                <Badge variant="outline" className="text-[9px] uppercase tracking-wide px-1 py-0">
                  Draft
                </Badge>
              )}
            </div>
          </div>
          {canEdit && (
            <GripVertical className="w-4 h-4 text-muted-foreground flex-shrink-0 cursor-grab" />
          )}
        </div>
      </div>
    </div>
  );
}

interface EmailListSidebarProps {
  emails: SequenceEmail[];
  selectedEmailId: string | null;
  onSelectEmail: (emailId: string) => void;
  onAddEmail: () => void;
  onReorderEmails?: (fromIndex: number, toIndex: number) => void;
  canEdit?: boolean;
}

export function EmailListSidebar({
  emails,
  selectedEmailId,
  onSelectEmail,
  onAddEmail,
  onReorderEmails,
  canEdit = true,
}: EmailListSidebarProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = (index: number) => {
    setDragIndex(index);
  };

  const handleDragOver = (index: number) => {
    if (dragIndex !== null && dragIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDragEnd = () => {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      onReorderEmails?.(dragIndex, dragOverIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="w-80 border-r bg-muted overflow-y-auto">
      <div className="p-3 space-y-2">
        {emails.map((email, index) => (
          <EmailItem
            key={email.id}
            email={email}
            index={index}
            isSelected={selectedEmailId === email.id}
            onSelect={() => onSelectEmail(email.id)}
            canEdit={canEdit}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            isDragging={dragIndex === index}
            dragOverIndex={dragOverIndex}
          />
        ))}

        {canEdit && (
          <Button
            variant="outline"
            className="w-full justify-center"
            onClick={onAddEmail}
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Email
          </Button>
        )}
      </div>
    </div>
  );
}

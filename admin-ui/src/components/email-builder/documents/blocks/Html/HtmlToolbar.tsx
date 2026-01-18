import { Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  AlignLeft,
  AlignCenter,
  AlignRight,
  RemoveFormatting,
  Undo2,
  Redo2,
  Link2,
  AtSign,
  ChevronDown,
} from 'lucide-react';
import { useState } from 'react';
import { Toggle } from '@/components/ui/toggle';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';

type HtmlToolbarProps = {
  editor: Editor;
};

const MERGE_FIELDS = [
  { label: 'First Name', value: 'first_name' },
  { label: 'Last Name', value: 'last_name' },
  { label: 'Company', value: 'company' },
  { label: 'Title', value: 'title' },
  { label: 'Email', value: 'email' },
  { label: 'Unsubscribe Link', value: 'unsubscribe_link' },
];

export default function HtmlToolbar({ editor }: HtmlToolbarProps) {
  const [linkUrl, setLinkUrl] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);

  const handleSetLink = () => {
    if (linkUrl) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    }
    setLinkOpen(false);
    setLinkUrl('');
  };

  const insertMergeField = (field: string) => {
    editor.chain().focus().insertContent(`{{${field}}}`).run();
  };

  const getCurrentTextStyle = () => {
    if (editor.isActive('heading', { level: 1 })) return 'Heading 1';
    if (editor.isActive('heading', { level: 2 })) return 'Heading 2';
    if (editor.isActive('heading', { level: 3 })) return 'Heading 3';
    return 'Paragraph';
  };

  return (
    <div className="flex items-center gap-0.5 p-1 bg-background border border-border rounded-lg shadow-lg">
      {/* Text Style Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 px-2 gap-1">
            <span className="text-xs min-w-[70px] text-left">{getCurrentTextStyle()}</span>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
            Paragraph
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
            Heading 1
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
            Heading 2
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
            Heading 3
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Undo/Redo */}
      <Toggle
        size="sm"
        pressed={false}
        onPressedChange={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        className="h-8 w-8 p-0"
      >
        <Undo2 className="h-4 w-4" />
      </Toggle>
      <Toggle
        size="sm"
        pressed={false}
        onPressedChange={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        className="h-8 w-8 p-0"
      >
        <Redo2 className="h-4 w-4" />
      </Toggle>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Text Formatting */}
      <Toggle
        size="sm"
        pressed={editor.isActive('bold')}
        onPressedChange={() => editor.chain().focus().toggleBold().run()}
        className="h-8 w-8 p-0"
      >
        <Bold className="h-4 w-4" />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor.isActive('italic')}
        onPressedChange={() => editor.chain().focus().toggleItalic().run()}
        className="h-8 w-8 p-0"
      >
        <Italic className="h-4 w-4" />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor.isActive('underline')}
        onPressedChange={() => editor.chain().focus().toggleUnderline().run()}
        className="h-8 w-8 p-0"
      >
        <Underline className="h-4 w-4" />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor.isActive('strike')}
        onPressedChange={() => editor.chain().focus().toggleStrike().run()}
        className="h-8 w-8 p-0"
      >
        <Strikethrough className="h-4 w-4" />
      </Toggle>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Alignment */}
      <Toggle
        size="sm"
        pressed={editor.isActive({ textAlign: 'left' })}
        onPressedChange={() => editor.chain().focus().setTextAlign('left').run()}
        className="h-8 w-8 p-0"
      >
        <AlignLeft className="h-4 w-4" />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor.isActive({ textAlign: 'center' })}
        onPressedChange={() => editor.chain().focus().setTextAlign('center').run()}
        className="h-8 w-8 p-0"
      >
        <AlignCenter className="h-4 w-4" />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor.isActive({ textAlign: 'right' })}
        onPressedChange={() => editor.chain().focus().setTextAlign('right').run()}
        className="h-8 w-8 p-0"
      >
        <AlignRight className="h-4 w-4" />
      </Toggle>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Clear Formatting */}
      <Toggle
        size="sm"
        pressed={false}
        onPressedChange={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
        className="h-8 w-8 p-0"
      >
        <RemoveFormatting className="h-4 w-4" />
      </Toggle>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Link */}
      <Popover open={linkOpen} onOpenChange={setLinkOpen}>
        <PopoverTrigger asChild>
          <Toggle
            size="sm"
            pressed={editor.isActive('link')}
            className="h-8 w-8 p-0"
          >
            <Link2 className="h-4 w-4" />
          </Toggle>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-2" align="start">
          <div className="flex gap-2">
            <Input
              placeholder="https://example.com"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSetLink();
                }
              }}
              className="h-8"
            />
            <Button size="sm" onClick={handleSetLink} className="h-8">
              {editor.isActive('link') ? 'Update' : 'Add'}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Merge Fields */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 px-2 gap-1">
            <AtSign className="h-4 w-4" />
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {MERGE_FIELDS.map((field) => (
            <DropdownMenuItem key={field.value} onClick={() => insertMergeField(field.value)}>
              {field.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

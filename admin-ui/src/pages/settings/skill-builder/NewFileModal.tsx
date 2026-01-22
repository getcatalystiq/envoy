import { useState } from 'react';
import { useSkillBuilder } from './SkillBuilderContext';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { File, Folder, Loader2 } from 'lucide-react';

interface NewFileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const TEMPLATES = [
  { label: 'SKILL.md', path: 'SKILL.md', type: 'file' as const },
  { label: 'Python Script', path: 'scripts/script.py', type: 'file' as const },
  { label: 'Shell Script', path: 'scripts/run.sh', type: 'file' as const },
  { label: 'Reference Doc', path: 'references/docs.md', type: 'file' as const },
];

export function NewFileModal({ isOpen, onClose }: NewFileModalProps) {
  const { createFile } = useSkillBuilder();
  const [path, setPath] = useState('');
  const [fileType, setFileType] = useState<'file' | 'directory'>('file');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!path.trim()) {
      setError('Please enter a path');
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      await createFile(path.trim(), fileType);
      onClose();
      setPath('');
      setFileType('file');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create file');
    } finally {
      setIsCreating(false);
    }
  };

  const handleTemplateClick = (template: typeof TEMPLATES[0]) => {
    setPath(template.path);
    setFileType(template.type);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
      setPath('');
      setFileType('file');
      setError(null);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New File</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* File type toggle */}
          <div className="flex gap-2">
            <button
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${
                fileType === 'file'
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
              onClick={() => setFileType('file')}
            >
              <File className="w-4 h-4" />
              File
            </button>
            <button
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${
                fileType === 'directory'
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
              onClick={() => setFileType('directory')}
            >
              <Folder className="w-4 h-4" />
              Folder
            </button>
          </div>

          {/* Path input */}
          <div className="space-y-2">
            <Label htmlFor="path">Path</Label>
            <Input
              id="path"
              placeholder={fileType === 'file' ? 'path/to/file.md' : 'path/to/folder'}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
          </div>

          {/* Quick templates */}
          {fileType === 'file' && (
            <div className="space-y-2">
              <Label className="text-gray-500 text-xs">Quick templates</Label>
              <div className="flex flex-wrap gap-2">
                {TEMPLATES.map((template) => (
                  <button
                    key={template.path}
                    className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                    onClick={() => handleTemplateClick(template)}
                  >
                    {template.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!path.trim() || isCreating}>
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              'Create'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

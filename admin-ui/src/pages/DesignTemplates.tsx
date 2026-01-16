import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Edit, Trash2, Archive, MoreVertical, Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  listDesignTemplates,
  createDesignTemplate,
  updateDesignTemplate,
  deleteDesignTemplate,
  type DesignTemplate,
  type BuilderContent,
} from '@/api/client';
import { Reader, type TReaderDocument } from '@/components/email-builder/Reader';

// Preview component for minified email template
function TemplatePreview({ content }: { content: BuilderContent | null }) {
  const document = content as TReaderDocument | null;
  const hasContent = document && Object.keys(document).length > 0 && document.root;

  if (!hasContent) {
    return (
      <div className="w-full h-[160px] bg-gray-50 rounded-md flex items-center justify-center border border-gray-100">
        <span className="text-xs text-gray-400">No preview</span>
      </div>
    );
  }

  return (
    <div className="w-full h-[160px] overflow-hidden rounded-md border border-gray-100 bg-white relative">
      <div
        className="absolute inset-0 origin-top-left pointer-events-none"
        style={{
          transform: 'scale(0.3)',
          width: '333.3%',
          height: '333.3%',
        }}
      >
        <Reader document={document} rootBlockId="root" />
      </div>
    </div>
  );
}

export function DesignTemplates() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<DesignTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadTemplates();
  }, [showArchived]);

  async function loadTemplates() {
    setLoading(true);
    setError(null);
    try {
      const data = await listDesignTemplates(showArchived);
      setTemplates(data);
    } catch (err) {
      setError('Failed to load templates');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const template = await createDesignTemplate({
        name: newName,
        description: newDescription || undefined,
      });
      setCreateOpen(false);
      setNewName('');
      setNewDescription('');
      navigate(`/design-templates/${template.id}`);
    } catch (err) {
      console.error('Failed to create template:', err);
    } finally {
      setCreating(false);
    }
  }

  async function handleArchive(id: string) {
    try {
      await updateDesignTemplate(id, { archived: true });
      loadTemplates();
    } catch (err) {
      console.error('Failed to archive template:', err);
    }
  }

  async function handleUnarchive(id: string) {
    try {
      await updateDesignTemplate(id, { archived: false });
      loadTemplates();
    } catch (err) {
      console.error('Failed to unarchive template:', err);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this template? This cannot be undone.')) return;
    try {
      await deleteDesignTemplate(id);
      loadTemplates();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete template';
      alert(message);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="text-center py-12 text-destructive">{error}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Design Templates</h1>
          <p className="text-gray-600">Manage email designs and branding</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Template
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="show-archived"
          checked={showArchived}
          onCheckedChange={(checked) => setShowArchived(checked === true)}
        />
        <Label htmlFor="show-archived" className="text-sm">Show archived</Label>
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Palette className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No templates yet</h3>
            <p className="text-gray-600 mb-4">Create your first email design template</p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Template
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((template) => (
            <Card
              key={template.id}
              className={`hover:shadow-md transition-shadow cursor-pointer overflow-hidden ${template.archived ? 'opacity-60' : ''}`}
              onClick={() => navigate(`/design-templates/${template.id}`)}
            >
              {/* Template Preview */}
              <div className="p-3 pb-0">
                <TemplatePreview content={template.builder_content} />
              </div>

              <div className="px-3 py-2">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-base truncate">{template.name}</h3>
                    {template.archived && (
                      <Badge variant="outline" className="text-xs mt-1">Archived</Badge>
                    )}
                    {template.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-1">{template.description}</p>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="h-8 w-8 -mr-2">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/design-templates/${template.id}`);
                      }}>
                        <Edit className="h-4 w-4 mr-2" />
                        Edit
                      </DropdownMenuItem>
                      {template.archived ? (
                        <DropdownMenuItem onClick={(e) => {
                          e.stopPropagation();
                          handleUnarchive(template.id);
                        }}>
                          <Archive className="h-4 w-4 mr-2" />
                          Unarchive
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={(e) => {
                          e.stopPropagation();
                          handleArchive(template.id);
                        }}>
                          <Archive className="h-4 w-4 mr-2" />
                          Archive
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(template.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Design Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="new-name">Name</Label>
              <Input
                id="new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Welcome Email Template"
              />
            </div>
            <div>
              <Label htmlFor="new-description">Description (optional)</Label>
              <Textarea
                id="new-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Template for welcome emails..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

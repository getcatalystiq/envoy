'use client';
import { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, MoreVertical, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  listTargetTypes,
  createTargetType,
  updateTargetType,
  deleteTargetType,
  getTargetTypeUsage,
  type TargetType,
  type TargetTypeUsageCount,
} from '@/lib/api';

export function TargetTypesList() {
  const [targetTypes, setTargetTypes] = useState<TargetType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editingType, setEditingType] = useState<TargetType | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [updating, setUpdating] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete dialog state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingType, setDeletingType] = useState<TargetType | null>(null);
  const [deleteUsage, setDeleteUsage] = useState<TargetTypeUsageCount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    loadTargetTypes();
  }, []);

  async function loadTargetTypes() {
    setLoading(true);
    setError(null);
    try {
      const data = await listTargetTypes();
      setTargetTypes(data);
    } catch {
      setError('Failed to load target types');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createTargetType({
        name: newName,
        description: newDescription || undefined,
      });
      setCreateOpen(false);
      setNewName('');
      setNewDescription('');
      loadTargetTypes();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create target type';
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  }

  function openEdit(targetType: TargetType) {
    setEditingType(targetType);
    setEditName(targetType.name);
    setEditDescription(targetType.description || '');
    setEditError(null);
    setEditOpen(true);
  }

  async function handleUpdate() {
    if (!editingType || !editName.trim()) return;
    setUpdating(true);
    setEditError(null);
    try {
      await updateTargetType(editingType.id, {
        name: editName,
        description: editDescription || undefined,
      });
      setEditOpen(false);
      setEditingType(null);
      loadTargetTypes();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update target type';
      setEditError(message);
    } finally {
      setUpdating(false);
    }
  }

  async function openDelete(targetType: TargetType) {
    setDeletingType(targetType);
    setDeleteError(null);
    setDeleteUsage(null);
    setDeleteOpen(true);
    try {
      const usage = await getTargetTypeUsage(targetType.id);
      setDeleteUsage(usage);
    } catch {
      setDeleteError('Failed to check usage');
    }
  }

  async function handleDelete() {
    if (!deletingType) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTargetType(deletingType.id);
      setDeleteOpen(false);
      setDeletingType(null);
      loadTargetTypes();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete target type';
      setDeleteError(message);
    } finally {
      setDeleting(false);
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
      <div className="text-center py-12 text-destructive">{error}</div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Target Types</h2>
          <p className="text-sm text-muted-foreground">
            Define categories for your targets (e.g., Lead, Customer, Partner)
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Target Type
        </Button>
      </div>

      {targetTypes.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Users className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No target types yet</h3>
            <p className="text-gray-600 mb-4">Create your first target type to categorize your contacts</p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Target Type
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">Name</th>
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">Description</th>
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">Created</th>
                <th className="h-10 px-4 text-right font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {targetTypes.map((type) => (
                <tr key={type.id} className="border-b last:border-0">
                  <td className="h-12 px-4 font-medium">{type.name}</td>
                  <td className="h-12 px-4 text-muted-foreground">
                    {type.description || <span className="italic">No description</span>}
                  </td>
                  <td className="h-12 px-4 text-muted-foreground">
                    {new Date(type.created_at).toLocaleDateString()}
                  </td>
                  <td className="h-12 px-4 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(type)}>
                          <Edit className="h-4 w-4 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => openDelete(type)}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Target Type</DialogTitle>
            <DialogDescription>
              Add a new target type to categorize your contacts
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="new-name">Name</Label>
              <Input
                id="new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Lead, Customer, Partner"
              />
            </div>
            <div>
              <Label htmlFor="new-description">Description (optional)</Label>
              <Textarea
                id="new-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Describe this target type..."
              />
            </div>
            {createError && (
              <p className="text-sm text-destructive">{createError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Target Type</DialogTitle>
            <DialogDescription>
              Update the target type details
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="e.g., Lead, Customer, Partner"
              />
            </div>
            <div>
              <Label htmlFor="edit-description">Description (optional)</Label>
              <Textarea
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Describe this target type..."
              />
            </div>
            {editError && (
              <p className="text-sm text-destructive">{editError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={!editName.trim() || updating}>
              {updating ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Target Type</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{deletingType?.name}&quot;?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {deleteUsage && (
              <div className="text-sm space-y-1">
                <p className="font-medium">This will affect:</p>
                <ul className="list-disc list-inside text-muted-foreground">
                  {deleteUsage.segments > 0 && (
                    <li>{deleteUsage.segments} segment(s) will be deleted</li>
                  )}
                  {deleteUsage.targets > 0 && (
                    <li>{deleteUsage.targets} target(s) will have their type cleared</li>
                  )}
                  {deleteUsage.content > 0 && (
                    <li>{deleteUsage.content} content item(s) will have their type cleared</li>
                  )}
                  {deleteUsage.sequences > 0 && (
                    <li className="text-destructive font-medium">
                      Cannot delete: {deleteUsage.sequences} sequence(s) use this type
                    </li>
                  )}
                </ul>
              </div>
            )}
            {deleteError && (
              <p className="text-sm text-destructive">{deleteError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting || (deleteUsage?.sequences ?? 0) > 0}
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

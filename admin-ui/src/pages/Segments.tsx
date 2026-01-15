import { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, MoreVertical, Tags, Filter } from 'lucide-react';
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
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { TagInput } from '@/components/ui/tag-input';
import {
  listSegments,
  listTargetTypes,
  createSegment,
  updateSegment,
  deleteSegment,
  getSegmentUsage,
  type Segment,
  type TargetType,
  type SegmentUsageCount,
} from '@/api/client';

export function SegmentsList() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [targetTypes, setTargetTypes] = useState<TargetType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterTypeId, setFilterTypeId] = useState<string>('all');

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newTargetTypeId, setNewTargetTypeId] = useState<string>('');
  const [newPainPoints, setNewPainPoints] = useState<string[]>([]);
  const [newObjections, setNewObjections] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editingSegment, setEditingSegment] = useState<Segment | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editTargetTypeId, setEditTargetTypeId] = useState<string>('');
  const [editPainPoints, setEditPainPoints] = useState<string[]>([]);
  const [editObjections, setEditObjections] = useState<string[]>([]);
  const [updating, setUpdating] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete dialog state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingSegment, setDeletingSegment] = useState<Segment | null>(null);
  const [deleteUsage, setDeleteUsage] = useState<SegmentUsageCount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    loadSegments();
  }, [filterTypeId]);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [typesData] = await Promise.all([
        listTargetTypes(),
      ]);
      setTargetTypes(typesData);
      // Load segments after we have target types
      await loadSegments();
    } catch {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  }

  async function loadSegments() {
    try {
      const targetTypeId = filterTypeId === 'all' ? undefined : filterTypeId;
      const data = await listSegments(targetTypeId);
      setSegments(data);
    } catch {
      setError('Failed to load segments');
    }
  }

  async function handleCreate() {
    if (!newName.trim() || !newTargetTypeId) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createSegment({
        name: newName,
        description: newDescription || undefined,
        target_type_id: newTargetTypeId,
        pain_points: newPainPoints.length > 0 ? newPainPoints : undefined,
        objections: newObjections.length > 0 ? newObjections : undefined,
      });
      setCreateOpen(false);
      resetCreateForm();
      loadSegments();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create segment';
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  }

  function resetCreateForm() {
    setNewName('');
    setNewDescription('');
    setNewTargetTypeId('');
    setNewPainPoints([]);
    setNewObjections([]);
  }

  function openEdit(segment: Segment) {
    setEditingSegment(segment);
    setEditName(segment.name);
    setEditDescription(segment.description || '');
    setEditTargetTypeId(segment.target_type_id);
    setEditPainPoints(segment.pain_points || []);
    setEditObjections(segment.objections || []);
    setEditError(null);
    setEditOpen(true);
  }

  async function handleUpdate() {
    if (!editingSegment || !editName.trim() || !editTargetTypeId) return;
    setUpdating(true);
    setEditError(null);
    try {
      await updateSegment(editingSegment.id, {
        name: editName,
        description: editDescription || undefined,
        target_type_id: editTargetTypeId,
        pain_points: editPainPoints,
        objections: editObjections,
      });
      setEditOpen(false);
      setEditingSegment(null);
      loadSegments();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update segment';
      setEditError(message);
    } finally {
      setUpdating(false);
    }
  }

  async function openDelete(segment: Segment) {
    setDeletingSegment(segment);
    setDeleteError(null);
    setDeleteUsage(null);
    setDeleteOpen(true);
    try {
      const usage = await getSegmentUsage(segment.id);
      setDeleteUsage(usage);
    } catch {
      setDeleteError('Failed to check usage');
    }
  }

  async function handleDelete() {
    if (!deletingSegment) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteSegment(deletingSegment.id);
      setDeleteOpen(false);
      setDeletingSegment(null);
      loadSegments();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete segment';
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

  // Show different empty state if no target types exist
  if (targetTypes.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Tags className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">Create Target Types First</h3>
          <p className="text-gray-600 mb-4">
            You need to create at least one target type before you can create segments.
            <br />
            Go to the Target Types tab to create one.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Segments</h2>
          <p className="text-sm text-muted-foreground">
            Define audience segments within your target types (e.g., Enterprise, SMB)
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Segment
        </Button>
      </div>

      {/* Filter by target type */}
      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <Select value={filterTypeId} onValueChange={setFilterTypeId}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by target type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Target Types</SelectItem>
            {targetTypes.map((type) => (
              <SelectItem key={type.id} value={type.id}>
                {type.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {segments.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Tags className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No segments yet</h3>
            <p className="text-gray-600 mb-4">
              Create your first segment to organize your targets into groups
            </p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Segment
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">Name</th>
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">Target Type</th>
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">Pain Points</th>
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">Objections</th>
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">Created</th>
                <th className="h-10 px-4 text-right font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((segment) => (
                <tr key={segment.id} className="border-b last:border-0">
                  <td className="h-12 px-4">
                    <div>
                      <p className="font-medium">{segment.name}</p>
                      {segment.description && (
                        <p className="text-sm text-muted-foreground truncate max-w-xs">
                          {segment.description}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="h-12 px-4">
                    <Badge variant="secondary">{segment.target_type_name}</Badge>
                  </td>
                  <td className="h-12 px-4">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {segment.pain_points.slice(0, 2).map((point) => (
                        <Badge key={point} variant="outline" className="text-xs">
                          {point}
                        </Badge>
                      ))}
                      {segment.pain_points.length > 2 && (
                        <Badge variant="outline" className="text-xs">
                          +{segment.pain_points.length - 2} more
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="h-12 px-4">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {segment.objections?.slice(0, 2).map((objection) => (
                        <Badge key={objection} variant="outline" className="text-xs">
                          {objection}
                        </Badge>
                      ))}
                      {(segment.objections?.length ?? 0) > 2 && (
                        <Badge variant="outline" className="text-xs">
                          +{(segment.objections?.length ?? 0) - 2} more
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="h-12 px-4 text-muted-foreground">
                    {new Date(segment.created_at).toLocaleDateString()}
                  </td>
                  <td className="h-12 px-4 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(segment)}>
                          <Edit className="h-4 w-4 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => openDelete(segment)}
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Segment</DialogTitle>
            <DialogDescription>
              Add a new audience segment for targeting
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="new-target-type">Target Type *</Label>
              <Select value={newTargetTypeId} onValueChange={setNewTargetTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a target type" />
                </SelectTrigger>
                <SelectContent>
                  {targetTypes.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="new-name">Name *</Label>
              <Input
                id="new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Enterprise, SMB, Startup"
              />
            </div>
            <div>
              <Label htmlFor="new-description">Description</Label>
              <Textarea
                id="new-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Describe this segment..."
              />
            </div>
            <div>
              <Label>Pain Points</Label>
              <TagInput
                value={newPainPoints}
                onChange={setNewPainPoints}
                placeholder="Add pain point and press Enter"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Common challenges this segment faces
              </p>
            </div>
            <div>
              <Label>Objections</Label>
              <TagInput
                value={newObjections}
                onChange={setNewObjections}
                placeholder="Add objection and press Enter"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Typical objections from this segment
              </p>
            </div>
            {createError && (
              <p className="text-sm text-destructive">{createError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={!newName.trim() || !newTargetTypeId || creating}
            >
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Segment</DialogTitle>
            <DialogDescription>
              Update the segment details
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-target-type">Target Type *</Label>
              <Select value={editTargetTypeId} onValueChange={setEditTargetTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a target type" />
                </SelectTrigger>
                <SelectContent>
                  {targetTypes.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="edit-name">Name *</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="e.g., Enterprise, SMB, Startup"
              />
            </div>
            <div>
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Describe this segment..."
              />
            </div>
            <div>
              <Label>Pain Points</Label>
              <TagInput
                value={editPainPoints}
                onChange={setEditPainPoints}
                placeholder="Add pain point and press Enter"
              />
            </div>
            <div>
              <Label>Objections</Label>
              <TagInput
                value={editObjections}
                onChange={setEditObjections}
                placeholder="Add objection and press Enter"
              />
            </div>
            {editError && (
              <p className="text-sm text-destructive">{editError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              onClick={handleUpdate}
              disabled={!editName.trim() || !editTargetTypeId || updating}
            >
              {updating ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Segment</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deletingSegment?.name}"?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {deleteUsage && (deleteUsage.targets > 0 || deleteUsage.content > 0) && (
              <div className="text-sm space-y-1">
                <p className="font-medium">This will affect:</p>
                <ul className="list-disc list-inside text-muted-foreground">
                  {deleteUsage.targets > 0 && (
                    <li>{deleteUsage.targets} target(s) will have their segment cleared</li>
                  )}
                  {deleteUsage.content > 0 && (
                    <li>{deleteUsage.content} content item(s) will have their segment cleared</li>
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
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

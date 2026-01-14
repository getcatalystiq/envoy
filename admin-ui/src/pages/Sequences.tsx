import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { api, type Sequence, type SequenceStatus, type CreateSequenceInput } from '@/api/client';
import {
  Plus,
  GitBranch,
  MoreVertical,
  Play,
  Archive,
  Trash2,
  Users,
  Layers,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface TargetType {
  id: string;
  name: string;
}

export function Sequences() {
  const navigate = useNavigate();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [targetTypes, setTargetTypes] = useState<TargetType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SequenceStatus | 'all'>('all');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [sequenceToDelete, setSequenceToDelete] = useState<Sequence | null>(null);
  const [newSequence, setNewSequence] = useState<CreateSequenceInput>({
    name: '',
    target_type_id: undefined,
  });
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadSequences();
    loadTargetTypes();
  }, [filter]);

  const loadSequences = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const endpoint = filter === 'all'
        ? '/sequences'
        : `/sequences?status=${filter}`;
      const data = await api.get<{ items: Sequence[] }>(endpoint);
      setSequences(data.items || []);
    } catch (err) {
      console.error('Failed to load sequences:', err);
      setError('Failed to load sequences');
    } finally {
      setIsLoading(false);
    }
  };

  const loadTargetTypes = async () => {
    try {
      const data = await api.get<{ items: TargetType[] }>('/targets/types');
      setTargetTypes(data.items || []);
    } catch (err) {
      console.error('Failed to load target types:', err);
    }
  };

  const handleCreateSequence = async () => {
    if (!newSequence.name.trim()) return;

    try {
      setIsCreating(true);
      const created = await api.post<Sequence>('/sequences', newSequence);
      setShowCreateDialog(false);
      setNewSequence({ name: '', target_type_id: undefined });
      navigate(`/sequences/${created.id}`);
    } catch (err) {
      console.error('Failed to create sequence:', err);
      setError('Failed to create sequence');
    } finally {
      setIsCreating(false);
    }
  };

  const handleActivate = async (sequence: Sequence) => {
    try {
      await api.post(`/sequences/${sequence.id}/activate`);
      await loadSequences();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to activate sequence';
      setError(message);
    }
  };

  const handleArchive = async (sequence: Sequence) => {
    try {
      await api.post(`/sequences/${sequence.id}/archive`);
      await loadSequences();
    } catch (err) {
      console.error('Failed to archive sequence:', err);
      setError('Failed to archive sequence');
    }
  };

  const handleDelete = async () => {
    if (!sequenceToDelete) return;

    try {
      await api.delete(`/sequences/${sequenceToDelete.id}`);
      setShowDeleteDialog(false);
      setSequenceToDelete(null);
      await loadSequences();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete sequence';
      setError(message);
      setShowDeleteDialog(false);
    }
  };

  const getStatusBadge = (status: SequenceStatus) => {
    switch (status) {
      case 'draft':
        return <Badge variant="outline">Draft</Badge>;
      case 'active':
        return <Badge variant="success">Active</Badge>;
      case 'archived':
        return <Badge variant="secondary">Archived</Badge>;
    }
  };

  const getTargetTypeName = (id: string | null) => {
    if (!id) return 'All targets';
    const targetType = targetTypes.find((t) => t.id === id);
    return targetType?.name || 'Unknown';
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const filteredSequences = sequences;
  const counts = {
    all: sequences.length,
    draft: sequences.filter((s) => s.status === 'draft').length,
    active: sequences.filter((s) => s.status === 'active').length,
    archived: sequences.filter((s) => s.status === 'archived').length,
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sequences</h1>
          <p className="text-gray-600">Build multi-step email sequences for automated outreach</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New Sequence
        </Button>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Status Filter Tabs */}
      <div className="grid grid-cols-4 gap-4">
        <Card
          className={cn(
            'cursor-pointer transition-colors',
            filter === 'all' && 'ring-2 ring-primary'
          )}
          onClick={() => setFilter('all')}
        >
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-gray-600" />
              <span className="text-sm text-gray-600">All</span>
            </div>
            <p className="text-2xl font-bold mt-1">{counts.all}</p>
          </CardContent>
        </Card>
        <Card
          className={cn(
            'cursor-pointer transition-colors',
            filter === 'draft' && 'ring-2 ring-primary'
          )}
          onClick={() => setFilter('draft')}
        >
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-gray-400" />
              <span className="text-sm text-gray-600">Draft</span>
            </div>
            <p className="text-2xl font-bold mt-1">{counts.draft}</p>
          </CardContent>
        </Card>
        <Card
          className={cn(
            'cursor-pointer transition-colors',
            filter === 'active' && 'ring-2 ring-primary'
          )}
          onClick={() => setFilter('active')}
        >
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Play className="w-4 h-4 text-green-600" />
              <span className="text-sm text-gray-600">Active</span>
            </div>
            <p className="text-2xl font-bold mt-1">{counts.active}</p>
          </CardContent>
        </Card>
        <Card
          className={cn(
            'cursor-pointer transition-colors',
            filter === 'archived' && 'ring-2 ring-primary'
          )}
          onClick={() => setFilter('archived')}
        >
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Archive className="w-4 h-4 text-gray-400" />
              <span className="text-sm text-gray-600">Archived</span>
            </div>
            <p className="text-2xl font-bold mt-1">{counts.archived}</p>
          </CardContent>
        </Card>
      </div>

      {/* Sequences List */}
      {filteredSequences.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <GitBranch className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {filter === 'all' ? 'Build your first sequence' : `No ${filter} sequences`}
            </h3>
            <p className="text-gray-600 mb-4">
              Create multi-step email sequences that automatically follow up with prospects
            </p>
            {filter === 'all' && (
              <Button onClick={() => setShowCreateDialog(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Create Sequence
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredSequences.map((sequence) => (
            <Card
              key={sequence.id}
              className="hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => navigate(`/sequences/${sequence.id}`)}
            >
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-gray-900">
                        {sequence.name}
                      </h3>
                      {getStatusBadge(sequence.status)}
                    </div>
                    <p className="text-sm text-gray-600 mb-4">
                      Target type: {getTargetTypeName(sequence.target_type_id)}
                    </p>
                    <div className="flex items-center gap-6 text-sm">
                      <div className="flex items-center gap-2 text-gray-600">
                        <Layers className="w-4 h-4" />
                        <span>{sequence.step_count ?? 0} steps</span>
                      </div>
                      <div className="flex items-center gap-2 text-gray-600">
                        <Users className="w-4 h-4" />
                        <span>{sequence.active_enrollments ?? 0} active enrollments</span>
                      </div>
                      <div className="text-gray-500">
                        Created {formatDate(sequence.created_at)}
                      </div>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                      <Button variant="ghost" size="sm">
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {sequence.status === 'draft' && (
                        <DropdownMenuItem
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            handleActivate(sequence);
                          }}
                        >
                          <Play className="w-4 h-4 mr-2" />
                          Activate
                        </DropdownMenuItem>
                      )}
                      {sequence.status === 'active' && (
                        <DropdownMenuItem
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            handleArchive(sequence);
                          }}
                        >
                          <Archive className="w-4 h-4 mr-2" />
                          Archive
                        </DropdownMenuItem>
                      )}
                      {sequence.status !== 'active' && (
                        <DropdownMenuItem
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            setSequenceToDelete(sequence);
                            setShowDeleteDialog(true);
                          }}
                          className="text-red-600"
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Sequence Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Sequence</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Sequence Name</Label>
              <Input
                id="name"
                placeholder="e.g., Welcome Series, Follow-up Campaign"
                value={newSequence.name}
                onChange={(e) => setNewSequence({ ...newSequence, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="target-type">Target Type (optional)</Label>
              <Select
                value={newSequence.target_type_id || 'all'}
                onValueChange={(value: string) =>
                  setNewSequence({
                    ...newSequence,
                    target_type_id: value === 'all' ? undefined : value,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="All targets" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All targets</SelectItem>
                  {targetTypes.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateSequence}
              disabled={!newSequence.name.trim() || isCreating}
            >
              {isCreating ? 'Creating...' : 'Create Sequence'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Sequence?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete "{sequenceToDelete?.name}"? This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

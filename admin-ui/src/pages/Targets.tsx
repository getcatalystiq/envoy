import { useEffect, useState } from 'react';
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
} from '@/components/ui/dialog';
import { api, type Target, type TargetType, type Segment } from '@/api/client';
import { Plus, Upload, Search, Users, ChevronLeft, ChevronRight, Pencil, Trash2 } from 'lucide-react';

const LIFECYCLE_STAGES = [
  'New',
  'Aware',
  'Engaged',
  'Qualified',
  'Opportunity',
  'Customer',
  'Advocate',
];

const PAGE_SIZES = [10, 25, 50, 100];

export function Targets() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetTypes, setTargetTypes] = useState<TargetType[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [editingTarget, setEditingTarget] = useState<Target | null>(null);
  const [deletingTarget, setDeletingTarget] = useState<Target | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    first_name: '',
    last_name: '',
    company: '',
    phone: '',
    target_type_id: '',
    segment_id: '',
    lifecycle_stage: 0,
  });

  useEffect(() => {
    loadTargets();
    loadTargetTypes();
    loadSegments();
  }, []);

  useEffect(() => {
    loadTargets();
  }, [page, pageSize]);

  const loadTargets = async () => {
    setIsLoading(true);
    try {
      const offset = (page - 1) * pageSize;
      const data = await api.get<{ items: Target[]; total: number }>(
        `/targets?limit=${pageSize}&offset=${offset}`
      );
      setTargets(data.items || []);
      setTotal(data.total || 0);
    } catch (error) {
      console.error('Failed to load targets:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadTargetTypes = async () => {
    try {
      const data = await api.get<TargetType[]>('/target-types');
      setTargetTypes(data || []);
    } catch (error) {
      console.error('Failed to load target types:', error);
    }
  };

  const loadSegments = async () => {
    try {
      const data = await api.get<Segment[]>('/segments');
      setSegments(data || []);
    } catch (error) {
      console.error('Failed to load segments:', error);
    }
  };

  const resetFormData = () => {
    setFormData({
      email: '',
      first_name: '',
      last_name: '',
      company: '',
      phone: '',
      target_type_id: '',
      segment_id: '',
      lifecycle_stage: 0,
    });
  };

  const handleAddTarget = async () => {
    if (!formData.email) return;
    setIsSaving(true);
    try {
      await api.post('/targets', {
        email: formData.email,
        first_name: formData.first_name || undefined,
        last_name: formData.last_name || undefined,
        company: formData.company || undefined,
        phone: formData.phone || undefined,
        target_type_id: formData.target_type_id || undefined,
        segment_id: formData.segment_id || undefined,
      });
      setShowAddDialog(false);
      resetFormData();
      loadTargets();
    } catch (error) {
      console.error('Failed to create target:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const openEditDialog = (target: Target) => {
    setEditingTarget(target);
    setFormData({
      email: target.email,
      first_name: target.first_name || '',
      last_name: target.last_name || '',
      company: target.company || '',
      phone: target.phone || '',
      target_type_id: target.target_type_id || '',
      segment_id: target.segment_id || '',
      lifecycle_stage: target.lifecycle_stage,
    });
    setShowEditDialog(true);
  };

  const handleEditTarget = async () => {
    if (!editingTarget || !formData.email) return;
    setIsSaving(true);
    try {
      await api.patch(`/targets/${editingTarget.id}`, {
        email: formData.email,
        first_name: formData.first_name || null,
        last_name: formData.last_name || null,
        company: formData.company || null,
        phone: formData.phone || null,
        lifecycle_stage: formData.lifecycle_stage,
        target_type_id: formData.target_type_id || null,
        segment_id: formData.segment_id || null,
      });
      setShowEditDialog(false);
      setEditingTarget(null);
      resetFormData();
      loadTargets();
    } catch (error) {
      console.error('Failed to update target:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const openDeleteDialog = (target: Target) => {
    setDeletingTarget(target);
    setShowDeleteDialog(true);
  };

  const handleDeleteTarget = async () => {
    if (!deletingTarget) return;
    setIsDeleting(true);
    try {
      await api.delete(`/targets/${deletingTarget.id}`);
      setShowDeleteDialog(false);
      setDeletingTarget(null);
      loadTargets();
    } catch (error) {
      console.error('Failed to delete target:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const getFullName = (target: Target) => {
    const parts = [target.first_name, target.last_name].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : null;
  };

  const getTargetTypeName = (typeId: string | null) => {
    if (!typeId) return '-';
    const type = targetTypes.find((t) => t.id === typeId);
    return type?.name || '-';
  };

  const getSegmentName = (segmentId: string | null) => {
    if (!segmentId) return '-';
    const segment = segments.find((s) => s.id === segmentId);
    return segment?.name || '-';
  };

  const filteredTargets = targets.filter((target) => {
    const searchLower = search.toLowerCase();
    const fullName = getFullName(target);
    return (
      target.email.toLowerCase().includes(searchLower) ||
      fullName?.toLowerCase().includes(searchLower) ||
      target.company?.toLowerCase().includes(searchLower) ||
      target.phone?.toLowerCase().includes(searchLower)
    );
  });

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant="success">Active</Badge>;
      case 'unsubscribed':
        return <Badge variant="warning">Unsubscribed</Badge>;
      case 'bounced':
        return <Badge variant="destructive">Bounced</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const maxVisible = 7;

    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      // Always show first page
      pages.push(1);

      if (page > 3) {
        pages.push('...');
      }

      // Show pages around current page
      const start = Math.max(2, page - 1);
      const end = Math.min(totalPages - 1, page + 1);

      for (let i = start; i <= end; i++) {
        if (!pages.includes(i)) {
          pages.push(i);
        }
      }

      if (page < totalPages - 2) {
        pages.push('...');
      }

      // Always show last page
      if (!pages.includes(totalPages)) {
        pages.push(totalPages);
      }
    }

    return pages;
  };

  const handlePageSizeChange = (newSize: string) => {
    setPageSize(Number(newSize));
    setPage(1); // Reset to first page when changing page size
  };

  if (isLoading && targets.length === 0) {
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
          <h1 className="text-2xl font-bold text-gray-900">Targets</h1>
          <p className="text-gray-600">Manage your prospect list</p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline">
            <Upload className="w-4 h-4 mr-2" />
            Import CSV
          </Button>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Add Target
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
          placeholder="Search by name, email, company, or phone..."
          className="pl-10"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Targets list */}
      {total === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Users className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No targets yet</h3>
            <p className="text-gray-600 mb-4">Import a CSV or add targets manually to get started</p>
            <div className="flex justify-center gap-3">
              <Button variant="outline">
                <Upload className="w-4 h-4 mr-2" />
                Import CSV
              </Button>
              <Button onClick={() => setShowAddDialog(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Add Target
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Name</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Email</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Company</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Phone</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Type</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Segment</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Stage</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Created</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Status</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTargets.map((target) => (
                  <tr
                    key={target.id}
                    className="border-b hover:bg-gray-50"
                  >
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {getFullName(target) || '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{target.email}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{target.company || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{target.phone || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {getTargetTypeName(target.target_type_id)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {getSegmentName(target.segment_id)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {LIFECYCLE_STAGES[target.lifecycle_stage] || target.lifecycle_stage}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {formatDate(target.created_at)}
                    </td>
                    <td className="px-4 py-3">{getStatusBadge(target.status)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditDialog(target)}
                          className="h-8 w-8 p-0"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openDeleteDialog(target)}
                          className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span>Rows per page:</span>
              <select
                value={pageSize}
                onChange={(e) => handlePageSizeChange(e.target.value)}
                className="h-8 px-2 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
              <span className="ml-4">
                {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, total)} of {total}
              </span>
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(1)}
                disabled={page === 1}
                className="h-8 px-2"
              >
                First
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(page - 1)}
                disabled={page === 1}
                className="h-8 w-8 p-0"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              {getPageNumbers().map((pageNum, idx) =>
                pageNum === '...' ? (
                  <span key={`ellipsis-${idx}`} className="px-2 text-gray-400">
                    ...
                  </span>
                ) : (
                  <Button
                    key={pageNum}
                    variant={page === pageNum ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setPage(pageNum as number)}
                    className="h-8 w-8 p-0"
                  >
                    {pageNum}
                  </Button>
                )
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(page + 1)}
                disabled={page === totalPages}
                className="h-8 w-8 p-0"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(totalPages)}
                disabled={page === totalPages}
                className="h-8 px-2"
              >
                Last
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Add Target Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Target</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-email">Email *</Label>
              <Input
                id="add-email"
                type="email"
                placeholder="email@example.com"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="add-first_name">First Name</Label>
                <Input
                  id="add-first_name"
                  placeholder="John"
                  value={formData.first_name}
                  onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-last_name">Last Name</Label>
                <Input
                  id="add-last_name"
                  placeholder="Doe"
                  value={formData.last_name}
                  onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-company">Company</Label>
              <Input
                id="add-company"
                placeholder="Acme Inc"
                value={formData.company}
                onChange={(e) => setFormData({ ...formData, company: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-phone">Phone</Label>
              <Input
                id="add-phone"
                placeholder="+1 555 123 4567"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="add-target_type">Target Type</Label>
                <select
                  id="add-target_type"
                  value={formData.target_type_id}
                  onChange={(e) => setFormData({ ...formData, target_type_id: e.target.value })}
                  className="w-full h-10 px-3 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">Select type...</option>
                  {targetTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-segment">Segment</Label>
                <select
                  id="add-segment"
                  value={formData.segment_id}
                  onChange={(e) => setFormData({ ...formData, segment_id: e.target.value })}
                  className="w-full h-10 px-3 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">Select segment...</option>
                  {segments.map((segment) => (
                    <option key={segment.id} value={segment.id}>
                      {segment.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-4">
              <Button variant="outline" onClick={() => setShowAddDialog(false)}>
                Cancel
              </Button>
              <Button onClick={handleAddTarget} disabled={!formData.email || isSaving}>
                {isSaving ? 'Adding...' : 'Add Target'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Target Dialog */}
      <Dialog open={showEditDialog} onOpenChange={(open) => {
        setShowEditDialog(open);
        if (!open) {
          setEditingTarget(null);
          resetFormData();
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Target</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-email">Email *</Label>
              <Input
                id="edit-email"
                type="email"
                placeholder="email@example.com"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-first_name">First Name</Label>
                <Input
                  id="edit-first_name"
                  placeholder="John"
                  value={formData.first_name}
                  onChange={(e) => setFormData({ ...formData, first_name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-last_name">Last Name</Label>
                <Input
                  id="edit-last_name"
                  placeholder="Doe"
                  value={formData.last_name}
                  onChange={(e) => setFormData({ ...formData, last_name: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-company">Company</Label>
              <Input
                id="edit-company"
                placeholder="Acme Inc"
                value={formData.company}
                onChange={(e) => setFormData({ ...formData, company: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-phone">Phone</Label>
              <Input
                id="edit-phone"
                placeholder="+1 555 123 4567"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-target_type">Target Type</Label>
                <select
                  id="edit-target_type"
                  value={formData.target_type_id}
                  onChange={(e) => setFormData({ ...formData, target_type_id: e.target.value })}
                  className="w-full h-10 px-3 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">Select type...</option>
                  {targetTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-segment">Segment</Label>
                <select
                  id="edit-segment"
                  value={formData.segment_id}
                  onChange={(e) => setFormData({ ...formData, segment_id: e.target.value })}
                  className="w-full h-10 px-3 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">Select segment...</option>
                  {segments.map((segment) => (
                    <option key={segment.id} value={segment.id}>
                      {segment.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-lifecycle_stage">Lifecycle Stage</Label>
              <select
                id="edit-lifecycle_stage"
                value={formData.lifecycle_stage}
                onChange={(e) => setFormData({ ...formData, lifecycle_stage: Number(e.target.value) })}
                className="w-full h-10 px-3 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {LIFECYCLE_STAGES.map((stage, index) => (
                  <option key={index} value={index}>
                    {stage}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-3 pt-4">
              <Button variant="outline" onClick={() => {
                setShowEditDialog(false);
                setEditingTarget(null);
                resetFormData();
              }}>
                Cancel
              </Button>
              <Button onClick={handleEditTarget} disabled={!formData.email || isSaving}>
                {isSaving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={(open) => {
        setShowDeleteDialog(open);
        if (!open) {
          setDeletingTarget(null);
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Target</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Are you sure you want to delete <strong>{deletingTarget?.email}</strong>? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3 pt-4">
              <Button variant="outline" onClick={() => {
                setShowDeleteDialog(false);
                setDeletingTarget(null);
              }}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteTarget}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

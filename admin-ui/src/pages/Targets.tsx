import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { api, type Target } from '@/api/client';
import { Plus, Upload, Search, Users, ChevronLeft, ChevronRight } from 'lucide-react';

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
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

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

  const getFullName = (target: Target) => {
    const parts = [target.first_name, target.last_name].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : null;
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
          <Button>
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
              <Button>
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
                </tr>
              </thead>
              <tbody>
                {filteredTargets.map((target) => (
                  <tr key={target.id} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <span className="font-medium text-gray-900">
                        {getFullName(target) || '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{target.email}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{target.company || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{target.phone || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {target.target_type_id ? (
                        <span className="text-xs text-gray-400">{target.target_type_id.slice(0, 8)}...</span>
                      ) : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {target.segment_id ? (
                        <span className="text-xs text-gray-400">{target.segment_id.slice(0, 8)}...</span>
                      ) : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {LIFECYCLE_STAGES[target.lifecycle_stage] || target.lifecycle_stage}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {formatDate(target.created_at)}
                    </td>
                    <td className="px-4 py-3">{getStatusBadge(target.status)}</td>
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
    </div>
  );
}

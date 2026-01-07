import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { api, type Target } from '@/api/client';
import { Plus, Upload, Search, Users, ExternalLink } from 'lucide-react';

export function Targets() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadTargets();
  }, []);

  const loadTargets = async () => {
    try {
      const data = await api.get<Target[]>('/targets');
      setTargets(data);
    } catch (error) {
      console.error('Failed to load targets:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredTargets = targets.filter(
    (target) =>
      target.email.toLowerCase().includes(search.toLowerCase()) ||
      target.name?.toLowerCase().includes(search.toLowerCase()) ||
      target.company?.toLowerCase().includes(search.toLowerCase())
  );

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'enriched':
        return <Badge variant="success">Enriched</Badge>;
      case 'pending':
        return <Badge variant="warning">Pending</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
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
          placeholder="Search by name, email, or company..."
          className="pl-10"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Targets list */}
      {targets.length === 0 ? (
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
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Title</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">Status</th>
                  <th className="text-left text-sm font-medium text-gray-600 px-4 py-3">LinkedIn</th>
                </tr>
              </thead>
              <tbody>
                {filteredTargets.map((target) => (
                  <tr key={target.id} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <span className="font-medium text-gray-900">
                        {target.name || '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{target.email}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{target.company || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{target.title || '-'}</td>
                    <td className="px-4 py-3">{getStatusBadge(target.status)}</td>
                    <td className="px-4 py-3">
                      {target.linkedin_url ? (
                        <a
                          href={target.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline flex items-center gap-1"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Profile
                        </a>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { api, type OutboxItem, type OutboxStats } from '@/api/client';
import {
  Check,
  X,
  Clock,
  Mail,
  AlertCircle,
  Send,
  Inbox,
  Eye,
  Edit2,
  MessageSquare,
  Smartphone,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export function Outbox() {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [stats, setStats] = useState<OutboxStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<OutboxItem | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editedSubject, setEditedSubject] = useState('');
  const [editedBody, setEditedBody] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [snoozeUntil, setSnoozeUntil] = useState('');
  const [showSnoozeDialog, setShowSnoozeDialog] = useState(false);
  const [filter, setFilter] = useState<string>('pending');

  useEffect(() => {
    loadOutbox();
    loadStats();
  }, [filter]);

  const loadOutbox = async () => {
    try {
      setIsLoading(true);
      const endpoint = filter === 'pending'
        ? '/outbox/pending'
        : `/outbox?status=${filter}`;
      const response = await api.get<{ items: OutboxItem[] }>(endpoint);
      setItems(response.items || []);
    } catch (error) {
      console.error('Failed to load outbox:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const data = await api.get<OutboxStats>('/outbox/stats');
      setStats(data);
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  const handleApprove = async (id: string) => {
    try {
      await api.post(`/outbox/${id}/approve`);
      await loadOutbox();
      await loadStats();
      setSelectedItem(null);
    } catch (error) {
      console.error('Failed to approve:', error);
    }
  };

  const handleReject = async () => {
    if (!selectedItem) return;
    try {
      await api.post(`/outbox/${selectedItem.id}/reject`, { reason: rejectReason });
      await loadOutbox();
      await loadStats();
      setSelectedItem(null);
      setShowRejectDialog(false);
      setRejectReason('');
    } catch (error) {
      console.error('Failed to reject:', error);
    }
  };

  const handleSnooze = async () => {
    if (!selectedItem || !snoozeUntil) return;
    try {
      await api.post(`/outbox/${selectedItem.id}/snooze`, { snooze_until: snoozeUntil });
      await loadOutbox();
      await loadStats();
      setSelectedItem(null);
      setShowSnoozeDialog(false);
      setSnoozeUntil('');
    } catch (error) {
      console.error('Failed to snooze:', error);
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await api.post(`/outbox/${id}/retry`);
      await loadOutbox();
      await loadStats();
      setSelectedItem(null);
    } catch (error) {
      console.error('Failed to retry:', error);
    }
  };

  const handleSaveEdit = async () => {
    if (!selectedItem) return;
    try {
      await api.patch(`/outbox/${selectedItem.id}`, {
        subject: editedSubject,
        body: editedBody,
      });
      await loadOutbox();
      setEditMode(false);
      setSelectedItem((prev) =>
        prev ? { ...prev, subject: editedSubject, body: editedBody } : null
      );
    } catch (error) {
      console.error('Failed to save:', error);
    }
  };

  const openItemDetail = (item: OutboxItem) => {
    setSelectedItem(item);
    setEditedSubject(item.subject || '');
    setEditedBody(item.body);
    setEditMode(false);
  };

  const getChannelIcon = (channel: string) => {
    switch (channel) {
      case 'email':
        return <Mail className="w-4 h-4" />;
      case 'linkedin':
        return <MessageSquare className="w-4 h-4" />;
      case 'sms':
        return <Smartphone className="w-4 h-4" />;
      default:
        return <Mail className="w-4 h-4" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="warning">Pending</Badge>;
      case 'approved':
        return <Badge variant="success">Approved</Badge>;
      case 'rejected':
        return <Badge variant="destructive">Rejected</Badge>;
      case 'snoozed':
        return <Badge variant="outline">Snoozed</Badge>;
      case 'sent':
        return <Badge variant="success">Sent</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getConfidenceBadge = (score: number | null) => {
    if (score === null) return null;
    if (score >= 0.9) {
      return (
        <Badge variant="success" className="text-xs">
          High ({Math.round(score * 100)}%)
        </Badge>
      );
    }
    if (score >= 0.7) {
      return (
        <Badge variant="warning" className="text-xs">
          Medium ({Math.round(score * 100)}%)
        </Badge>
      );
    }
    return (
      <Badge variant="destructive" className="text-xs">
        Low ({Math.round(score * 100)}%)
      </Badge>
    );
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
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
          <h1 className="text-2xl font-bold text-gray-900">Outbox</h1>
          <p className="text-gray-600">Review and approve AI-generated content</p>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <Card
            className={cn(
              'cursor-pointer transition-colors',
              filter === 'pending' && 'ring-2 ring-primary'
            )}
            onClick={() => setFilter('pending')}
          >
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <Inbox className="w-4 h-4 text-yellow-600" />
                <span className="text-sm text-gray-600">Pending</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.pending}</p>
            </CardContent>
          </Card>
          <Card
            className={cn(
              'cursor-pointer transition-colors',
              filter === 'approved' && 'ring-2 ring-primary'
            )}
            onClick={() => setFilter('approved')}
          >
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-600" />
                <span className="text-sm text-gray-600">Approved</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.approved}</p>
            </CardContent>
          </Card>
          <Card
            className={cn(
              'cursor-pointer transition-colors',
              filter === 'rejected' && 'ring-2 ring-primary'
            )}
            onClick={() => setFilter('rejected')}
          >
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <X className="w-4 h-4 text-red-600" />
                <span className="text-sm text-gray-600">Rejected</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.rejected}</p>
            </CardContent>
          </Card>
          <Card
            className={cn(
              'cursor-pointer transition-colors',
              filter === 'snoozed' && 'ring-2 ring-primary'
            )}
            onClick={() => setFilter('snoozed')}
          >
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-gray-600" />
                <span className="text-sm text-gray-600">Snoozed</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.snoozed}</p>
            </CardContent>
          </Card>
          <Card
            className={cn(
              'cursor-pointer transition-colors',
              filter === 'sent' && 'ring-2 ring-primary'
            )}
            onClick={() => setFilter('sent')}
          >
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <Send className="w-4 h-4 text-blue-600" />
                <span className="text-sm text-gray-600">Sent</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.sent}</p>
            </CardContent>
          </Card>
          <Card
            className={cn(
              'cursor-pointer transition-colors',
              filter === 'failed' && 'ring-2 ring-primary'
            )}
            onClick={() => setFilter('failed')}
          >
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-600" />
                <span className="text-sm text-gray-600">Failed</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.failed}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Outbox list */}
      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Inbox className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              No {filter} items
            </h3>
            <p className="text-gray-600">
              {filter === 'pending'
                ? 'All caught up! No content waiting for review.'
                : `No items with status "${filter}".`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <Card
              key={item.id}
              className="hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => openItemDetail(item)}
            >
              <CardContent className="py-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      {getChannelIcon(item.channel)}
                      <span className="font-medium text-gray-900">
                        {item.first_name} {item.last_name}
                      </span>
                      <span className="text-gray-500">
                        {item.email || 'No email'}
                      </span>
                      {item.company && (
                        <span className="text-gray-400">@ {item.company}</span>
                      )}
                    </div>
                    {item.subject && (
                      <p className="font-medium text-gray-800 mb-1 truncate">
                        {item.subject}
                      </p>
                    )}
                    <p className="text-sm text-gray-600 line-clamp-2">
                      {item.body}
                    </p>
                    <div className="flex items-center gap-3 mt-3">
                      {getStatusBadge(item.status)}
                      {getConfidenceBadge(item.confidence_score)}
                      <span className="text-xs text-gray-400">
                        {item.skill_name}
                      </span>
                      <span className="text-xs text-gray-400">
                        {formatDate(item.created_at)}
                      </span>
                    </div>
                    {item.status === 'failed' && item.send_result?.error && (
                      <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate">{String(item.send_result.error)}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        openItemDetail(item);
                      }}
                    >
                      <Eye className="w-4 h-4" />
                    </Button>
                    {item.status === 'pending' && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-green-600 hover:text-green-700 hover:bg-green-50"
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            handleApprove(item.id);
                          }}
                        >
                          <Check className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            setSelectedItem(item);
                            setShowRejectDialog(true);
                          }}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                    {item.status === 'failed' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          handleRetry(item.id);
                        }}
                      >
                        <RotateCcw className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Item Detail Dialog */}
      <Dialog
        open={selectedItem !== null && !showRejectDialog && !showSnoozeDialog}
        onOpenChange={(open: boolean) => !open && setSelectedItem(null)}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {selectedItem && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {getChannelIcon(selectedItem.channel)}
                  <span>
                    {selectedItem.first_name} {selectedItem.last_name}
                  </span>
                  {getStatusBadge(selectedItem.status)}
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                {/* Target info */}
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-sm">
                    <span className="text-gray-500">Email:</span>{' '}
                    {selectedItem.email || 'N/A'}
                  </p>
                  {selectedItem.company && (
                    <p className="text-sm">
                      <span className="text-gray-500">Company:</span>{' '}
                      {selectedItem.company}
                    </p>
                  )}
                  <p className="text-sm">
                    <span className="text-gray-500">Skill:</span>{' '}
                    {selectedItem.skill_name}
                  </p>
                  {selectedItem.confidence_score !== null && (
                    <p className="text-sm flex items-center gap-2">
                      <span className="text-gray-500">Confidence:</span>
                      {getConfidenceBadge(selectedItem.confidence_score)}
                    </p>
                  )}
                </div>

                {/* Subject */}
                {(selectedItem.subject || editMode) && (
                  <div>
                    <label className="text-sm font-medium text-gray-700">
                      Subject
                    </label>
                    {editMode ? (
                      <Input
                        value={editedSubject}
                        onChange={(e) => setEditedSubject(e.target.value)}
                        className="mt-1"
                      />
                    ) : (
                      <p className="mt-1 text-gray-900">
                        {selectedItem.subject}
                      </p>
                    )}
                  </div>
                )}

                {/* Body */}
                <div>
                  <label className="text-sm font-medium text-gray-700">
                    Body
                  </label>
                  {editMode ? (
                    <Textarea
                      value={editedBody}
                      onChange={(e) => setEditedBody(e.target.value)}
                      className="mt-1 min-h-[200px]"
                    />
                  ) : (
                    <div className="mt-1 p-3 bg-white border rounded-lg whitespace-pre-wrap">
                      {selectedItem.body}
                    </div>
                  )}
                </div>

                {/* Error for failed items */}
                {selectedItem.status === 'failed' && selectedItem.send_result?.error && (
                  <div>
                    <label className="text-sm font-medium text-gray-700">
                      Error
                    </label>
                    <div className="mt-1 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-900 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <span>{String(selectedItem.send_result.error)}</span>
                    </div>
                  </div>
                )}

                {/* Reasoning */}
                {selectedItem.skill_reasoning && (
                  <div>
                    <label className="text-sm font-medium text-gray-700">
                      AI Reasoning
                    </label>
                    <div className="mt-1 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900 whitespace-pre-wrap">
                      {selectedItem.skill_reasoning}
                    </div>
                  </div>
                )}

                {/* Edit history */}
                {selectedItem.edit_history?.length > 0 && (
                  <div>
                    <label className="text-sm font-medium text-gray-700">
                      Edit History
                    </label>
                    <div className="mt-1 space-y-2">
                      {selectedItem.edit_history.map((edit, i) => (
                        <div
                          key={i}
                          className="text-xs p-2 bg-gray-50 rounded"
                        >
                          <span className="text-gray-500">
                            {formatDate(edit.timestamp)}
                          </span>
                          : Edited {edit.field}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <DialogFooter className="flex-col sm:flex-row gap-2">
                {selectedItem.status === 'pending' && (
                  <>
                    {editMode ? (
                      <>
                        <Button
                          variant="outline"
                          onClick={() => setEditMode(false)}
                        >
                          Cancel
                        </Button>
                        <Button onClick={handleSaveEdit}>Save Changes</Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          onClick={() => setEditMode(true)}
                        >
                          <Edit2 className="w-4 h-4 mr-2" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setShowSnoozeDialog(true)}
                        >
                          <Clock className="w-4 h-4 mr-2" />
                          Snooze
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={() => setShowRejectDialog(true)}
                        >
                          <X className="w-4 h-4 mr-2" />
                          Reject
                        </Button>
                        <Button
                          onClick={() => handleApprove(selectedItem.id)}
                        >
                          <Check className="w-4 h-4 mr-2" />
                          Approve
                        </Button>
                      </>
                    )}
                  </>
                )}
                {selectedItem.status === 'failed' && (
                  <Button
                    onClick={() => handleRetry(selectedItem.id)}
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Retry
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Content</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700">
                Reason (optional)
              </label>
              <Textarea
                value={rejectReason}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRejectReason(e.target.value)}
                placeholder="Why is this content being rejected?"
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRejectDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReject}>
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Snooze Dialog */}
      <Dialog open={showSnoozeDialog} onOpenChange={setShowSnoozeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Snooze Until</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700">
                Snooze until
              </label>
              <Input
                type="datetime-local"
                value={snoozeUntil}
                onChange={(e) => setSnoozeUntil(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSnoozeDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSnooze} disabled={!snoozeUntil}>
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

'use client';
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
import { api, type OutboxItem, type OutboxStats } from '@/lib/api';
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
  CheckCircle2,
  MousePointerClick,
  Ban,
  Flag,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { MenuButton } from '@/components/Layout';

export default function OutboxPage() {
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
  const [targetDataExpanded, setTargetDataExpanded] = useState(false);

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
    setTargetDataExpanded(false);
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

  const renderEngagementMetrics = (item: OutboxItem) => {
    if (item.status !== 'sent') return null;

    const metrics = [
      { key: 'delivered', value: item.delivered_at, icon: CheckCircle2, activeColor: 'text-green-600', label: 'Delivered' },
      { key: 'opened', value: item.opened_at, icon: Eye, activeColor: 'text-blue-600', label: 'Opened' },
      { key: 'clicked', value: item.clicked_at, icon: MousePointerClick, activeColor: 'text-purple-600', label: 'Clicked' },
    ];

    const negativeMetrics = [
      { key: 'bounced', value: item.bounced_at, icon: Ban, activeColor: 'text-red-600', label: 'Bounced' },
      { key: 'complained', value: item.complained_at, icon: Flag, activeColor: 'text-orange-600', label: 'Complained' },
    ].filter((m) => m.value);

    return (
      <div className="flex items-center gap-1">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          const isActive = !!metric.value;
          return (
            <div
              key={metric.key}
              className="relative group"
              title={isActive ? `${metric.label}: ${formatDate(metric.value!)}` : `Not ${metric.label.toLowerCase()}`}
            >
              <Icon className={cn('w-4 h-4', isActive ? metric.activeColor : 'text-muted-foreground')} />
            </div>
          );
        })}
        {negativeMetrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div key={metric.key} className="relative group" title={`${metric.label}: ${formatDate(metric.value!)}`}>
              <Icon className={cn('w-4 h-4', metric.activeColor)} />
            </div>
          );
        })}
      </div>
    );
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
        <div className="flex items-center gap-3">
          <MenuButton />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Outbox</h1>
            <p className="text-muted-foreground">Review and approve AI-generated content</p>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <Card className={cn('cursor-pointer transition-colors', filter === 'pending' && 'ring-2 ring-primary')} onClick={() => setFilter('pending')}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <Inbox className="w-4 h-4 text-yellow-600" />
                <span className="text-sm text-muted-foreground">Pending</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.pending}</p>
            </CardContent>
          </Card>
          <Card className={cn('cursor-pointer transition-colors', filter === 'approved' && 'ring-2 ring-primary')} onClick={() => setFilter('approved')}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-600" />
                <span className="text-sm text-muted-foreground">Approved</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.approved}</p>
            </CardContent>
          </Card>
          <Card className={cn('cursor-pointer transition-colors', filter === 'rejected' && 'ring-2 ring-primary')} onClick={() => setFilter('rejected')}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <X className="w-4 h-4 text-red-600" />
                <span className="text-sm text-muted-foreground">Rejected</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.rejected}</p>
            </CardContent>
          </Card>
          <Card className={cn('cursor-pointer transition-colors', filter === 'snoozed' && 'ring-2 ring-primary')} onClick={() => setFilter('snoozed')}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Snoozed</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.snoozed}</p>
            </CardContent>
          </Card>
          <Card className={cn('cursor-pointer transition-colors', filter === 'sent' && 'ring-2 ring-primary')} onClick={() => setFilter('sent')}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <Send className="w-4 h-4 text-blue-600" />
                <span className="text-sm text-muted-foreground">Sent</span>
              </div>
              <p className="text-2xl font-bold mt-1">{stats.sent}</p>
            </CardContent>
          </Card>
          <Card className={cn('cursor-pointer transition-colors', filter === 'failed' && 'ring-2 ring-primary')} onClick={() => setFilter('failed')}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-600" />
                <span className="text-sm text-muted-foreground">Failed</span>
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
            <Inbox className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">
              No {filter} items
            </h3>
            <p className="text-muted-foreground">
              {filter === 'pending'
                ? 'All caught up! No content waiting for review.'
                : `No items with status "${filter}".`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <Card key={item.id} className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => openItemDetail(item)}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      {getChannelIcon(item.channel)}
                      <span className="font-medium text-foreground">{item.first_name} {item.last_name}</span>
                      <span className="text-muted-foreground">{item.email || 'No email'}</span>
                      {item.company && <span className="text-muted-foreground">@ {item.company}</span>}
                    </div>
                    {item.subject && <p className="font-medium text-foreground mb-1 truncate">{item.subject}</p>}
                    <div className="flex items-center gap-3 mt-3">
                      {getStatusBadge(item.status)}
                      {getConfidenceBadge(item.confidence_score)}
                      {renderEngagementMetrics(item)}
                      <span className="text-xs text-muted-foreground">{formatDate(item.created_at)}</span>
                    </div>
                    {item.status === 'failed' && !!item.send_result?.error && (
                      <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate">{String(item.send_result.error)}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Button size="sm" variant="ghost" onClick={(e: React.MouseEvent) => { e.stopPropagation(); openItemDetail(item); }}>
                      <Eye className="w-4 h-4" />
                    </Button>
                    {item.status === 'pending' && (
                      <>
                        <Button size="sm" variant="ghost" className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950" onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleApprove(item.id); }}>
                          <Check className="w-4 h-4" />
                        </Button>
                        <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950" onClick={(e: React.MouseEvent) => { e.stopPropagation(); setSelectedItem(item); setShowRejectDialog(true); }}>
                          <X className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                    {item.status === 'failed' && (
                      <Button size="sm" variant="ghost" className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950" onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleRetry(item.id); }}>
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
                  <span>{selectedItem.first_name} {selectedItem.last_name}</span>
                  {getStatusBadge(selectedItem.status)}
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                <div className="bg-muted rounded-lg p-3">
                  <p className="text-sm"><span className="text-muted-foreground">Email:</span> {selectedItem.email || 'N/A'}</p>
                  {selectedItem.company && <p className="text-sm"><span className="text-muted-foreground">Company:</span> {selectedItem.company}</p>}
                  {selectedItem.confidence_score !== null && (
                    <p className="text-sm flex items-center gap-2"><span className="text-muted-foreground">Confidence:</span>{getConfidenceBadge(selectedItem.confidence_score)}</p>
                  )}
                </div>

                {selectedItem.status === 'sent' && (
                  <div className="bg-muted rounded-lg p-3">
                    <label className="text-sm font-medium text-foreground mb-2 block">Engagement</label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className={cn('w-4 h-4', selectedItem.delivered_at ? 'text-green-600' : 'text-muted-foreground')} />
                        <div className="text-sm">
                          <span className="text-foreground">Delivered</span>
                          {selectedItem.delivered_at && <p className="text-xs text-muted-foreground">{formatDate(selectedItem.delivered_at)}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Eye className={cn('w-4 h-4', selectedItem.opened_at ? 'text-blue-600' : 'text-muted-foreground')} />
                        <div className="text-sm">
                          <span className="text-foreground">Opened</span>
                          {selectedItem.opened_at && <p className="text-xs text-muted-foreground">{formatDate(selectedItem.opened_at)}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <MousePointerClick className={cn('w-4 h-4', selectedItem.clicked_at ? 'text-purple-600' : 'text-muted-foreground')} />
                        <div className="text-sm">
                          <span className="text-foreground">Clicked</span>
                          {selectedItem.clicked_at && <p className="text-xs text-muted-foreground">{formatDate(selectedItem.clicked_at)}</p>}
                        </div>
                      </div>
                      {selectedItem.bounced_at && (
                        <div className="flex items-center gap-2">
                          <Ban className="w-4 h-4 text-red-600" />
                          <div className="text-sm"><span className="text-foreground">Bounced</span><p className="text-xs text-muted-foreground">{formatDate(selectedItem.bounced_at)}</p></div>
                        </div>
                      )}
                      {selectedItem.complained_at && (
                        <div className="flex items-center gap-2">
                          <Flag className="w-4 h-4 text-orange-600" />
                          <div className="text-sm"><span className="text-foreground">Complained</span><p className="text-xs text-muted-foreground">{formatDate(selectedItem.complained_at)}</p></div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {!!(selectedItem.subject || editMode) && (
                  <div>
                    <label className="text-sm font-medium text-foreground">Subject</label>
                    {editMode ? (
                      <Input value={editedSubject} onChange={(e) => setEditedSubject(e.target.value)} className="mt-1" />
                    ) : (
                      <p className="mt-1 text-foreground">{selectedItem.subject}</p>
                    )}
                  </div>
                )}

                <div>
                  <label className="text-sm font-medium text-foreground">Body</label>
                  {editMode ? (
                    <Textarea value={editedBody} onChange={(e) => setEditedBody(e.target.value)} className="mt-1 min-h-[200px]" />
                  ) : (
                    <iframe srcDoc={selectedItem.body} className="mt-1 w-full min-h-[400px] bg-muted border rounded-lg" sandbox="allow-same-origin" title="Email preview" />
                  )}
                </div>

                {selectedItem.status === 'failed' && !!selectedItem.send_result?.error && (
                  <div>
                    <label className="text-sm font-medium text-foreground">Error</label>
                    <div className="mt-1 p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-900 dark:text-red-200 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <span>{String(selectedItem.send_result.error)}</span>
                    </div>
                  </div>
                )}

                <div className="bg-muted rounded-lg p-3">
                  <button
                    type="button"
                    className="flex items-center gap-1 text-sm font-medium text-foreground w-full text-left"
                    onClick={() => setTargetDataExpanded(!targetDataExpanded)}
                  >
                    {targetDataExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    Target Data
                  </button>
                  {targetDataExpanded && (
                    <div className="space-y-1 text-sm mt-2">
                      <p><span className="text-muted-foreground">Email:</span> {selectedItem.email || 'N/A'}</p>
                      <p><span className="text-muted-foreground">Name:</span> {[selectedItem.first_name, selectedItem.last_name].filter(Boolean).join(' ') || 'N/A'}</p>
                      <p><span className="text-muted-foreground">Company:</span> {selectedItem.company || 'N/A'}</p>
                      {selectedItem.metadata && Object.keys(selectedItem.metadata).length > 0 && (
                        <div className="mt-2 pt-2 border-t border-border">
                          <span className="text-muted-foreground block mb-1">Metadata:</span>
                          <div className="pl-2 space-y-1">
                            {Object.entries(selectedItem.metadata).map(([key, value]) => (
                              <p key={key} className="text-foreground">
                                <span className="text-muted-foreground">{key}:</span> {typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}
                              </p>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {selectedItem.edit_history?.length > 0 && (
                  <div>
                    <label className="text-sm font-medium text-foreground">Edit History</label>
                    <div className="mt-1 space-y-2">
                      {selectedItem.edit_history.map((edit, i) => (
                        <div key={i} className="text-xs p-2 bg-muted rounded">
                          <span className="text-muted-foreground">{formatDate(edit.timestamp)}</span>: Edited {edit.field}
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
                        <Button variant="outline" onClick={() => setEditMode(false)}>Cancel</Button>
                        <Button onClick={handleSaveEdit}>Save Changes</Button>
                      </>
                    ) : (
                      <>
                        <Button variant="outline" onClick={() => setEditMode(true)}>
                          <Edit2 className="w-4 h-4 mr-2" />Edit
                        </Button>
                        <Button variant="outline" onClick={() => setShowSnoozeDialog(true)}>
                          <Clock className="w-4 h-4 mr-2" />Snooze
                        </Button>
                        <Button variant="destructive" onClick={() => setShowRejectDialog(true)}>
                          <X className="w-4 h-4 mr-2" />Reject
                        </Button>
                        <Button onClick={() => handleApprove(selectedItem.id)}>
                          <Check className="w-4 h-4 mr-2" />Approve
                        </Button>
                      </>
                    )}
                  </>
                )}
                {selectedItem.status === 'failed' && (
                  <Button onClick={() => handleRetry(selectedItem.id)}>
                    <RotateCcw className="w-4 h-4 mr-2" />Retry
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
          <DialogHeader><DialogTitle>Reject Content</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground">Reason (optional)</label>
              <Textarea value={rejectReason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRejectReason(e.target.value)} placeholder="Why is this content being rejected?" className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRejectDialog(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleReject}>Reject</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Snooze Dialog */}
      <Dialog open={showSnoozeDialog} onOpenChange={setShowSnoozeDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Snooze Until</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground">Snooze until</label>
              <Input type="datetime-local" value={snoozeUntil} onChange={(e) => setSnoozeUntil(e.target.value)} className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSnoozeDialog(false)}>Cancel</Button>
            <Button onClick={handleSnooze} disabled={!snoozeUntil}>Snooze</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

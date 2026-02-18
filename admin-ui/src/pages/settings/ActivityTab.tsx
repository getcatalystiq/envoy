/**
 * AI Activity - view recent agent runs and transcripts.
 * Uses AgentPlane runs model with NDJSON transcript events.
 */
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/api/client';
import { Activity, MessageSquare, Clock, Loader2, ChevronRight, RefreshCw, Wrench, ChevronDown, ChevronUp, DollarSign, RotateCw } from 'lucide-react';

interface Run {
  id: string;
  status: string;
  created_at: string;
  cost_usd?: number;
  turns?: number;
  duration_ms?: number;
}

interface TranscriptEvent {
  type: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

interface RunDetail {
  id: string;
  status: string;
  created_at: string;
  cost_usd?: number;
  turns?: number;
  duration_ms?: number;
  transcript?: TranscriptEvent[];
}

function TranscriptEventCard({ event }: { event: TranscriptEvent }) {
  const [expanded, setExpanded] = useState(false);

  const getEventColor = (type: string) => {
    switch (type) {
      case 'tool_use':
        return 'bg-purple-100 text-purple-800';
      case 'tool_result':
        return 'bg-blue-100 text-blue-800';
      case 'text':
        return 'bg-gray-100 text-gray-800';
      case 'error':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const isToolEvent = event.type === 'tool_use' || event.type === 'tool_result';

  return (
    <div className="border border-gray-200 rounded-md bg-white">
      <button
        className="w-full flex items-center justify-between p-2 text-left hover:bg-gray-50"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {isToolEvent && <Wrench className="w-3 h-3 text-gray-400" />}
          <Badge variant="outline" className={`text-xs ${getEventColor(event.type)}`}>
            {event.type}
          </Badge>
          {event.data?.name && (
            <span className="text-sm font-mono">{String(event.data.name)}</span>
          )}
          {event.data?.text && (
            <span className="text-sm text-gray-600 truncate max-w-xs">
              {String(event.data.text).slice(0, 80)}
            </span>
          )}
        </div>
        {event.data && (
          expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />
        )}
      </button>
      {expanded && event.data && (
        <div className="p-2 border-t border-gray-200 bg-gray-50">
          <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto">
            {JSON.stringify(event.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    completed: 'bg-green-100 text-green-800',
    running: 'bg-blue-100 text-blue-800',
    failed: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-800',
  };
  return (
    <Badge variant="outline" className={variants[status] || 'bg-gray-100 text-gray-800'}>
      {status}
    </Badge>
  );
}

export function ActivityTab() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<RunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRuns();
  }, []);

  const loadRuns = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.get<{ runs: Run[] }>('/agentplane/runs');
      setRuns(data?.runs || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const loadDetail = async (runId: string) => {
    setIsLoadingDetail(true);
    setError(null);
    try {
      const data = await api.get<RunDetail>(`/agentplane/runs/${runId}`);
      setSelectedDetail(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const formatFullDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const formatCost = (usd: number) => {
    return `$${usd.toFixed(4)}`;
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5" />
              AI Activity
            </CardTitle>
            <CardDescription>
              Recent AI agent runs and conversation transcripts
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={loadRuns}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">
            {error}
          </div>
        )}

        {runs.length === 0 ? (
          <div className="text-center py-8">
            <Activity className="w-12 h-12 mx-auto text-gray-300 mb-4" />
            <p className="text-gray-500">No AI activity recorded yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors text-left"
                onClick={() => loadDetail(run.id)}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <MessageSquare className="w-5 h-5 text-gray-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm font-mono truncate">
                      {run.id}
                    </p>
                    <div className="flex items-center gap-3 text-sm text-gray-500">
                      <StatusBadge status={run.status} />
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDate(run.created_at)}
                      </span>
                      {run.turns !== undefined && (
                        <span className="flex items-center gap-1">
                          <RotateCw className="w-3 h-3" />
                          {run.turns} turns
                        </span>
                      )}
                      {run.cost_usd !== undefined && (
                        <span className="flex items-center gap-1">
                          <DollarSign className="w-3 h-3" />
                          {formatCost(run.cost_usd)}
                        </span>
                      )}
                      {run.duration_ms !== undefined && (
                        <span>{formatDuration(run.duration_ms)}</span>
                      )}
                    </div>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-400" />
              </button>
            ))}
          </div>
        )}
      </CardContent>

      {/* Detail Dialog */}
      <Dialog open={!!selectedDetail} onOpenChange={() => setSelectedDetail(null)}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5" />
              Run Transcript
            </DialogTitle>
          </DialogHeader>
          {isLoadingDetail ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : selectedDetail ? (
            <div className="flex-1 overflow-y-auto space-y-4 pr-2">
              <div className="text-sm text-gray-500 mb-4 p-3 bg-gray-50 rounded-lg">
                <div className="grid grid-cols-2 gap-2">
                  <p><strong>Run:</strong> {selectedDetail.id}</p>
                  <p><strong>Status:</strong> <StatusBadge status={selectedDetail.status} /></p>
                  <p><strong>Started:</strong> {formatFullDate(selectedDetail.created_at)}</p>
                  {selectedDetail.turns !== undefined && <p><strong>Turns:</strong> {selectedDetail.turns}</p>}
                  {selectedDetail.cost_usd !== undefined && <p><strong>Cost:</strong> {formatCost(selectedDetail.cost_usd)}</p>}
                  {selectedDetail.duration_ms !== undefined && <p><strong>Duration:</strong> {formatDuration(selectedDetail.duration_ms)}</p>}
                </div>
              </div>

              {selectedDetail.transcript && selectedDetail.transcript.length > 0 ? (
                <div className="space-y-1">
                  {selectedDetail.transcript.map((event, idx) => (
                    <TranscriptEventCard key={idx} event={event} />
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-4">No transcript events</p>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

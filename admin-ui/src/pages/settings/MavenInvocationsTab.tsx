/**
 * AI Activity - view recent invocations and transcripts.
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
import { Activity, MessageSquare, Clock, Loader2, ChevronRight, RefreshCw, Wrench, ChevronDown, ChevronUp } from 'lucide-react';

interface Invocation {
  session_id: string;
  last_modified: string;
  size: number;
}

interface ToolCall {
  type: string;
  name: string;
  input?: Record<string, unknown>;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  context?: unknown;
  tools?: ToolCall[];
  cache_metrics?: unknown;
}

interface InvocationDetail {
  sessionId: string;
  tenantId: string;
  userId: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  metadata?: unknown;
}

function ToolCallDisplay({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  const getToolBadgeColor = (type: string) => {
    switch (type) {
      case 'builtin':
        return 'bg-blue-100 text-blue-800';
      case 'mcp':
        return 'bg-purple-100 text-purple-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const formatToolName = (name: string) => {
    // Remove mcp__ prefix and format nicely
    return name.replace(/^mcp__/, '').replace(/__/g, ' → ');
  };

  return (
    <div className="border border-gray-200 rounded-md bg-white">
      <button
        className="w-full flex items-center justify-between p-2 text-left hover:bg-gray-50"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Wrench className="w-3 h-3 text-gray-400" />
          <Badge variant="outline" className={`text-xs ${getToolBadgeColor(tool.type)}`}>
            {tool.type}
          </Badge>
          <span className="text-sm font-mono">{formatToolName(tool.name)}</span>
        </div>
        {tool.input && (
          expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />
        )}
      </button>
      {expanded && tool.input && (
        <div className="p-2 border-t border-gray-200 bg-gray-50">
          <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function MavenInvocationsTab() {
  const [invocations, setInvocations] = useState<Invocation[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<InvocationDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadInvocations();
  }, []);

  const loadInvocations = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.get<{ invocations: Invocation[] }>('/maven/invocations');
      setInvocations(data?.invocations || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const loadDetail = async (sessionId: string) => {
    setIsLoadingDetail(true);
    setError(null);
    try {
      const data = await api.get<InvocationDetail>(`/maven/invocations/${sessionId}`);
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

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
              Recent AI invocations and conversation transcripts
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={loadInvocations}>
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

        {invocations.length === 0 ? (
          <div className="text-center py-8">
            <Activity className="w-12 h-12 mx-auto text-gray-300 mb-4" />
            <p className="text-gray-500">No AI activity recorded yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {invocations.map((inv) => (
              <button
                key={inv.session_id}
                className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors text-left"
                onClick={() => loadDetail(inv.session_id)}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <MessageSquare className="w-5 h-5 text-gray-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm font-mono truncate">
                      {inv.session_id}
                    </p>
                    <div className="flex items-center gap-3 text-sm text-gray-500">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDate(inv.last_modified)}
                      </span>
                      <span>{formatSize(inv.size)}</span>
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
              Conversation Transcript
            </DialogTitle>
          </DialogHeader>
          {isLoadingDetail ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : selectedDetail ? (
            <div className="flex-1 overflow-y-auto space-y-4 pr-2">
              <div className="text-sm text-gray-500 mb-4 p-3 bg-gray-50 rounded-lg">
                <p><strong>Session:</strong> {selectedDetail.sessionId}</p>
                <p><strong>Started:</strong> {formatFullDate(selectedDetail.created_at)}</p>
                <p><strong>Messages:</strong> {selectedDetail.messages?.length || 0}</p>
              </div>
              {selectedDetail.messages?.map((msg, idx) => (
                <div key={idx} className="space-y-2">
                  <div
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-lg p-3 ${
                        msg.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-gray-100 text-gray-900'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium opacity-70">
                          {msg.role === 'user' ? 'User' : 'Assistant'}
                        </span>
                        <span className="text-xs opacity-50">
                          {formatFullDate(msg.timestamp)}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>

                  {/* Tool Calls */}
                  {msg.tools && msg.tools.length > 0 && (
                    <div className="ml-4 space-y-1">
                      <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                        <Wrench className="w-3 h-3" />
                        <span>{msg.tools.length} tool call{msg.tools.length > 1 ? 's' : ''}</span>
                      </div>
                      <div className="space-y-1">
                        {msg.tools.map((tool, toolIdx) => (
                          <ToolCallDisplay key={toolIdx} tool={tool} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

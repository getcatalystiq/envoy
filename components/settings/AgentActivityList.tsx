'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, formatApiError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';

interface AgentSession {
  id: string;
  status: string;
  created_at: string;
}

interface SessionsResponse {
  sessions: AgentSession[];
}

// Managed Agents session statuses: idle | running | rescheduling | terminated.
function statusBadge(status: string) {
  const variant =
    status === 'idle'
      ? 'default'
      : status === 'terminated'
        ? 'destructive'
        : 'secondary'; // running, rescheduling
  return (
    <Badge variant={variant as 'default' | 'secondary' | 'destructive'}>{status}</Badge>
  );
}

export function AgentActivityList() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);

  useEffect(() => {
    api
      .get<SessionsResponse>('/agent/sessions?limit=50')
      .then((data) => {
        // sessions.list returns newest-first; sort defensively all the same.
        const byNewest = (a: AgentSession, b: AgentSession) =>
          (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
        setSessions([...(data.sessions ?? [])].sort(byNewest));
      })
      .catch((err) => {
        // Distinguish "no agent configured" (503) from a transient error by
        // HTTP status, not by parsing the error body.
        if ((err as { status?: number }).status === 503) {
          setUnconfigured(true);
        } else {
          setError(formatApiError(err));
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (unconfigured) {
    return (
      <p className="text-sm text-muted-foreground">
        No agent configured.{' '}
        <Link href="/settings?tab=instructions" className="underline">
          Configure your agent
        </Link>{' '}
        to start seeing activity.
      </p>
    );
  }

  if (error) {
    return <p className="text-sm text-muted-foreground">{error}</p>;
  }

  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No sessions yet.</p>;
  }

  return (
    <div className="border rounded-md divide-y">
      {sessions.map((session) => (
        <Link
          key={session.id}
          href={`/settings/sessions/${session.id}`}
          className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors"
        >
          <span className="font-mono text-xs truncate min-w-0">{session.id}</span>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{new Date(session.created_at).toLocaleString()}</span>
            {statusBadge(session.status)}
          </div>
        </Link>
      ))}
    </div>
  );
}

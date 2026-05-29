'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, formatApiError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import type { TwinRun } from '@/lib/twin';

interface RunsResponse {
  runs: TwinRun[];
  total_runs: number;
  page: number;
  page_size: number;
}

function statusBadge(run: TwinRun) {
  const status = run.status ?? (run.is_finished ? 'finished' : 'in_progress');
  const variant =
    status === 'finished' || status === 'completed'
      ? 'default'
      : status === 'failed' || status === 'error'
      ? 'destructive'
      : 'secondary';
  return <Badge variant={variant as 'default' | 'secondary' | 'destructive'}>{status}</Badge>;
}

export function TwinRunsList() {
  const [runs, setRuns] = useState<TwinRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<RunsResponse>('/twin/runs?page=1&page_size=50')
      .then((data) => setRuns(data.runs ?? []))
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-muted-foreground">{error}</p>;
  }

  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  return (
    <div className="border rounded-md divide-y">
      {runs.map((run) => (
        <Link
          key={run.run_id}
          href={`/settings/runs/${run.run_id}`}
          className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-mono text-xs text-muted-foreground">#{run.run_number}</span>
            <span className="font-mono text-xs truncate">{run.run_id}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{run.event_count} events</span>
            <span>{new Date(run.started_at).toLocaleString()}</span>
            {statusBadge(run)}
          </div>
        </Link>
      ))}
    </div>
  );
}

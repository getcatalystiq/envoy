'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { api, formatApiError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { TwinRun, TwinRunEvent } from '@/lib/twin';

type RunWithTranscript = TwinRun & { transcript?: TwinRunEvent[] };

export default function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const [run, setRun] = useState<TwinRun | null>(null);
  const [events, setEvents] = useState<TwinRunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<RunWithTranscript>(`/twin/runs/${runId}`)
      .then((data) => {
        const { transcript, ...rest } = data;
        setRun(rest as TwinRun);
        setEvents(transcript ?? []);
      })
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));
  }, [runId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3">
        <p className="text-muted-foreground">{error || 'Run not found'}</p>
        <Link href="/settings?tab=ai-activity">
          <Button variant="outline">Back to AI Activity</Button>
        </Link>
      </div>
    );
  }

  const status = run.status ?? (run.is_finished ? 'finished' : 'in_progress');

  return (
    <div className="flex flex-col h-screen">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/settings?tab=ai-activity">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
          </Link>
          <h1 className="font-semibold">Run #{run.run_number}</h1>
          <Badge>{status}</Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          {run.event_count} events · {run.step_count} steps · started{' '}
          {new Date(run.started_at).toLocaleString()}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-2">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events recorded.</p>
        ) : (
          events.map((e) => (
            <details key={e.event_index} className="border rounded-md">
              <summary className="cursor-pointer px-3 py-2 text-xs flex items-center gap-3">
                <span className="font-mono text-muted-foreground">#{e.event_index}</span>
                <span className="text-muted-foreground">
                  {new Date(e.recorded_at).toLocaleTimeString()}
                </span>
                <span className="font-mono truncate">{summarizeEvent(e.event)}</span>
              </summary>
              <pre className="px-3 pb-3 text-xs overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(e.event, null, 2)}
              </pre>
            </details>
          ))
        )}
      </div>
    </div>
  );
}

function summarizeEvent(event: Record<string, unknown>): string {
  const keys = Object.keys(event);
  if (keys.length === 0) return '(empty)';
  return keys[0];
}

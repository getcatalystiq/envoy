'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { api, formatApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface AgentEvent {
  type?: string;
  processed_at?: string;
  content?: Array<{ type?: string; text?: string }>;
  [k: string]: unknown;
}

function messageText(event: AgentEvent): string {
  if (!Array.isArray(event.content)) return '';
  return event.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

export default function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ sessionId: string; events: AgentEvent[] }>(`/agent/sessions/${sessionId}`)
      .then((data) => setEvents(data.events ?? []))
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));
  }, [sessionId]);

  // The final agent.message text is what the admin came to see.
  const finalMessage = [...events].reverse().find((e) => e.type === 'agent.message');
  const resultText = finalMessage ? messageText(finalMessage) : '';

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
          <h1 className="font-semibold font-mono text-sm truncate">{sessionId}</h1>
        </div>
        <div className="text-xs text-muted-foreground">{events.length} events</div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {loading ? (
          <>
            <div className="h-24 rounded-md border bg-muted/40 animate-pulse" />
            <div className="space-y-2">
              <div className="h-9 rounded-md border bg-muted/40 animate-pulse" />
              <div className="h-9 rounded-md border bg-muted/40 animate-pulse" />
              <div className="h-9 rounded-md border bg-muted/40 animate-pulse" />
            </div>
          </>
        ) : error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : (
          <>
            <div className="space-y-2">
              <h2 className="text-sm font-medium">Result</h2>
              {resultText ? (
                <pre className="border rounded-md p-3 text-xs whitespace-pre-wrap overflow-x-auto bg-muted/30">
                  {resultText}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No agent output.</p>
              )}
            </div>

            <div className="space-y-2">
              <h2 className="text-sm font-medium">Events</h2>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events recorded.</p>
              ) : (
                <div className="space-y-2">
                  {events.map((e, i) => (
                    <details key={i} className="border rounded-md">
                      <summary className="cursor-pointer px-3 py-2 text-xs flex items-center gap-3">
                        <span className="font-mono truncate">{e.type ?? '(unknown)'}</span>
                        {e.processed_at && (
                          <span className="text-muted-foreground">
                            {new Date(e.processed_at).toLocaleTimeString()}
                          </span>
                        )}
                      </summary>
                      <pre className="px-3 pb-3 text-xs overflow-x-auto whitespace-pre-wrap">
                        {JSON.stringify(e, null, 2)}
                      </pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

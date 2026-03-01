'use client';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

export function CTA() {
  return (
    <section className="py-24 bg-primary">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
          Stop sending the same email to everyone
        </h2>
        <p className="text-lg text-white/80 mb-8 max-w-2xl mx-auto">
          Envoy is open source. Deploy it on your own infrastructure and let AI
          write personalized drip sequences that actually get replies.
        </p>
        <a
          href="https://github.com/getcatalystiq/envoy"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 bg-background text-foreground font-semibold text-base px-8 py-4 rounded-lg hover:bg-muted transition-colors"
        >
          View on GitHub
          <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    </section>
  );
}

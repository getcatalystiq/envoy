'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowRight, Sparkles, Send, Clock, ChevronRight } from 'lucide-react';

const steps = [
  {
    day: 'Day 1',
    subject: 'Quick question about your Q4 goals',
    preview: 'Hi Sarah, I noticed Acme Corp just launched...',
    status: 'delivered',
  },
  {
    day: 'Day 3',
    subject: 'Re: A resource for your expansion plans',
    preview: 'Following up — I put together a short case study...',
    status: 'opened',
  },
  {
    day: 'Day 7',
    subject: 'Re: One more thought on personalization',
    preview: 'Sarah, one last thing — given your role leading...',
    status: 'writing',
  },
];

export function Hero() {
  const [activeStep, setActiveStep] = useState(0);
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveStep((prev) => (prev + 1) % steps.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const cursorInterval = setInterval(() => {
      setShowCursor((prev) => !prev);
    }, 530);
    return () => clearInterval(cursorInterval);
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-b from-muted to-background pt-20">
      {/* Background pattern */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }}
      />

      {/* Gradient orbs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[120px]" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-[120px]" />

      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-20 lg:py-32">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left column - Text content */}
          <div className="text-center lg:text-left">
            {/* Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 text-sm text-primary mb-8 animate-fade-in">
              <Sparkles className="h-4 w-4" />
              <span>AI-Powered Drip Sequences</span>
            </div>

            {/* Headline */}
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-foreground leading-[1.1] tracking-tight mb-6 animate-fade-in-up">
              Drip campaigns that{' '}
              <span className="text-primary">write themselves</span>
            </h1>

            {/* Subheadline */}
            <p className="text-lg sm:text-xl text-muted-foreground max-w-xl mx-auto lg:mx-0 mb-10 leading-relaxed animate-fade-in-up animation-delay-100">
              Build multi-step email sequences where every message is AI-personalized
              to each recipient. Envoy researches your prospects and writes unique
              follow-ups that convert.
            </p>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start animate-fade-in-up animation-delay-200">
              <Button size="lg" className="text-base px-8 py-6 shadow-lg shadow-primary/20" asChild>
                <a
                  href="https://github.com/getcatalystiq/envoy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on GitHub
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button size="lg" variant="outline" className="text-base px-8 py-6" asChild>
                <a href="#how-it-works">
                  See How It Works
                </a>
              </Button>
            </div>

            {/* Trust indicator */}
            <p className="text-sm text-muted-foreground mt-8 animate-fade-in-up animation-delay-300">
              Open source. Self-host or deploy to Vercel in minutes.
            </p>
          </div>

          {/* Right column - Sequence mockup */}
          <div className="relative animate-fade-in-up animation-delay-200">
            {/* Glow behind the card */}
            <div className="absolute -inset-4 bg-gradient-to-r from-primary/20 via-primary/10 to-transparent rounded-3xl blur-2xl opacity-60" />

            {/* Sequence window */}
            <div className="relative bg-background rounded-2xl border shadow-2xl overflow-hidden">
              {/* Window header */}
              <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-400" />
                  <div className="w-3 h-3 rounded-full bg-yellow-400" />
                  <div className="w-3 h-3 rounded-full bg-green-400" />
                </div>
                <span className="text-xs text-muted-foreground ml-2">Sequence: Enterprise Outreach</span>
              </div>

              {/* Target info */}
              <div className="px-4 py-3 border-b bg-muted/50 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">SJ</div>
                <div>
                  <div className="text-sm font-medium text-foreground">Sarah Johnson</div>
                  <div className="text-xs text-muted-foreground">VP Marketing, Acme Corp</div>
                </div>
              </div>

              {/* Sequence steps */}
              <div className="p-4 space-y-3">
                {steps.map((step, index) => (
                  <div
                    key={index}
                    className={`rounded-xl border p-3 transition-all duration-500 ${
                      index === activeStep
                        ? 'border-primary/30 bg-primary/5 shadow-sm'
                        : 'border-border bg-background'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${
                        step.status === 'delivered' ? 'bg-green-100 dark:bg-green-900' :
                        step.status === 'opened' ? 'bg-blue-100 dark:bg-blue-900' :
                        'bg-primary/10'
                      }`}>
                        {step.status === 'writing' ? (
                          <Sparkles className="w-4 h-4 text-primary" />
                        ) : step.status === 'opened' ? (
                          <Send className="w-4 h-4 text-blue-600" />
                        ) : (
                          <Clock className="w-4 h-4 text-green-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-medium text-primary">{step.day}</span>
                          {step.status === 'delivered' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 font-medium">Delivered</span>
                          )}
                          {step.status === 'opened' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-medium">Opened</span>
                          )}
                          {step.status === 'writing' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium flex items-center gap-1">
                              <Sparkles className="w-2.5 h-2.5" />
                              AI writing
                            </span>
                          )}
                        </div>
                        <div className="text-sm font-medium text-foreground truncate">{step.subject}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {step.preview}
                          {step.status === 'writing' && index === activeStep && (
                            <span className={`inline-block w-0.5 h-3 bg-primary ml-0.5 ${showCursor ? 'opacity-100' : 'opacity-0'}`} />
                          )}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    </div>
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div className="px-4 py-3 border-t bg-muted flex justify-between items-center">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Sparkles className="w-3 h-3 text-primary" />
                  <span>Each email personalized by AI</span>
                </div>
                <span className="text-xs text-muted-foreground">3 steps &middot; 7 days</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight, Sparkles, Send } from 'lucide-react';

const emailSubject = "Quick question about your Q4 marketing goals";
const emailBody = `Hi Sarah,

I noticed Acme Corp just launched a new product line. Congrats!

Given your focus on enterprise expansion, I thought you might be interested in how companies like yours are using AI to personalize outreach at scale.

Would you have 15 minutes this week to explore if this could help with your Q4 targets?

Best,
Alex`;

export function Hero() {
  const [displayedSubject, setDisplayedSubject] = useState('');
  const [displayedBody, setDisplayedBody] = useState('');
  const [phase, setPhase] = useState<'subject' | 'body' | 'done'>('subject');
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    let currentIndex = 0;

    const startDelay = setTimeout(() => {
      const typingInterval = setInterval(() => {
        if (phase === 'subject') {
          if (currentIndex <= emailSubject.length) {
            setDisplayedSubject(emailSubject.slice(0, currentIndex));
            currentIndex++;
          } else {
            clearInterval(typingInterval);
            setTimeout(() => {
              currentIndex = 0;
              setPhase('body');
            }, 300);
          }
        }
      }, 40);
      return () => clearInterval(typingInterval);
    }, 800);

    return () => clearTimeout(startDelay);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'body') return;

    let currentIndex = 0;
    const typingInterval = setInterval(() => {
      if (currentIndex <= emailBody.length) {
        setDisplayedBody(emailBody.slice(0, currentIndex));
        currentIndex++;
      } else {
        clearInterval(typingInterval);
        setPhase('done');
      }
    }, 15);

    return () => clearInterval(typingInterval);
  }, [phase]);

  useEffect(() => {
    const cursorInterval = setInterval(() => {
      setShowCursor((prev) => !prev);
    }, 530);
    return () => clearInterval(cursorInterval);
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-b from-gray-50 to-white pt-20">
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
              <span>AI-Powered Sales Outreach</span>
            </div>

            {/* Headline */}
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-gray-900 leading-[1.1] tracking-tight mb-6 animate-fade-in-up">
              Write personalized emails{' '}
              <span className="text-primary">10x faster</span> with AI
            </h1>

            {/* Subheadline */}
            <p className="text-lg sm:text-xl text-gray-600 max-w-xl mx-auto lg:mx-0 mb-10 leading-relaxed animate-fade-in-up animation-delay-100">
              Envoy researches your prospects and writes hyper-personalized cold emails
              that get responses. Stop sending generic templates that get ignored.
            </p>

            {/* CTAs */}
            <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start animate-fade-in-up animation-delay-200">
              <Button size="lg" className="text-base px-8 py-6 shadow-lg shadow-primary/20" asChild>
                <Link to="/login">
                  Start Free Trial
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" className="text-base px-8 py-6" asChild>
                <a href="#how-it-works">
                  See How It Works
                </a>
              </Button>
            </div>

            {/* Trust indicator */}
            <p className="text-sm text-gray-500 mt-8 animate-fade-in-up animation-delay-300">
              No credit card required. 50 free emails to start.
            </p>
          </div>

          {/* Right column - Email mockup */}
          <div className="relative animate-fade-in-up animation-delay-200">
            {/* Glow behind the card */}
            <div className="absolute -inset-4 bg-gradient-to-r from-primary/20 via-primary/10 to-transparent rounded-3xl blur-2xl opacity-60" />

            {/* Email window */}
            <div className="relative bg-white rounded-2xl border shadow-2xl overflow-hidden">
              {/* Window header */}
              <div className="flex items-center gap-2 px-4 py-3 border-b bg-gray-50">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-400" />
                  <div className="w-3 h-3 rounded-full bg-yellow-400" />
                  <div className="w-3 h-3 rounded-full bg-green-400" />
                </div>
                <span className="text-xs text-gray-500 ml-2">New Message</span>
              </div>

              {/* Email fields */}
              <div className="p-4 space-y-3 border-b">
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-gray-400 w-12">To:</span>
                  <span className="text-gray-700">sarah.johnson@acmecorp.com</span>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-gray-400 w-12">Subject:</span>
                  <span className="text-gray-900 font-medium">
                    {displayedSubject}
                    {phase === 'subject' && (
                      <span className={`inline-block w-0.5 h-4 bg-primary ml-0.5 ${showCursor ? 'opacity-100' : 'opacity-0'}`} />
                    )}
                  </span>
                </div>
              </div>

              {/* Email body */}
              <div className="p-4 min-h-[240px]">
                <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">
                  {displayedBody}
                  {phase === 'body' && (
                    <span className={`inline-block w-0.5 h-4 bg-primary ml-0.5 ${showCursor ? 'opacity-100' : 'opacity-0'}`} />
                  )}
                </pre>
              </div>

              {/* Send button */}
              <div className="px-4 py-3 border-t bg-gray-50 flex justify-between items-center">
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Sparkles className="w-3 h-3 text-primary" />
                  <span>AI-generated from LinkedIn research</span>
                </div>
                <Button size="sm" className={phase === 'done' ? 'animate-pulse' : 'opacity-50'}>
                  <Send className="w-4 h-4 mr-2" />
                  Send
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

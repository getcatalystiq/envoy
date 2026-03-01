'use client';
import {
  Sparkles,
  GitBranch,
  Clock,
  BarChart3,
  UserCheck,
  Blocks
} from 'lucide-react';

const features = [
  {
    icon: GitBranch,
    title: 'Multi-Step Sequences',
    description: 'Build drip campaigns with multiple steps, delays, and conditions. Drag and drop to design your ideal follow-up flow.',
  },
  {
    icon: Sparkles,
    title: 'AI-Personalized at Every Step',
    description: 'Each email in the sequence is uniquely written for the recipient using AI that researches their role, company, and context.',
  },
  {
    icon: Clock,
    title: 'Automated Scheduling',
    description: 'Set delays between steps and let Envoy handle the timing. Sequences run on autopilot so you never miss a follow-up.',
  },
  {
    icon: BarChart3,
    title: 'Engagement Tracking',
    description: 'Track opens, clicks, bounces, and complaints across every step. See which messages in your sequence perform best.',
  },
  {
    icon: UserCheck,
    title: 'Lifecycle Graduation',
    description: 'Automatically advance targets through lifecycle stages as they engage. Stop emailing prospects who already converted.',
  },
  {
    icon: Blocks,
    title: 'Visual Email Builder',
    description: 'Design emails with a block-based editor. Add AI personalization to individual blocks for fine-grained control.',
  },
];

export function Features() {
  return (
    <section id="features" className="py-24 bg-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Drip sequences, supercharged with AI
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Every feature is built around multi-step email sequences where
            AI personalizes each message for each recipient.
          </p>
        </div>

        {/* Feature grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <div
              key={feature.title}
              className="p-6 rounded-2xl border bg-muted/50 hover:bg-background hover:shadow-lg transition-all duration-300 animate-fade-in-up"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                <feature.icon className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">
                {feature.title}
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

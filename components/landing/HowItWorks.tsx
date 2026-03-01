'use client';
import { Upload, GitBranch, Sparkles, Repeat } from 'lucide-react';

const steps = [
  {
    icon: Upload,
    step: '01',
    title: 'Import Your Targets',
    description: 'Upload prospects via CSV, webhook, or the API. Envoy stores their details and segments them by type.',
  },
  {
    icon: GitBranch,
    step: '02',
    title: 'Build a Sequence',
    description: 'Design a multi-step drip campaign with the drag-and-drop sequence builder. Set delays and conditions between steps.',
  },
  {
    icon: Sparkles,
    step: '03',
    title: 'AI Writes Each Email',
    description: 'For every target at every step, AI generates a unique email personalized to their role, company, and context.',
  },
  {
    icon: Repeat,
    step: '04',
    title: 'Drip on Autopilot',
    description: 'Envoy sends emails on schedule, tracks engagement, and graduates targets through lifecycle stages automatically.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            How Envoy Works
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            From prospect list to AI-powered drip sequence in four steps.
          </p>
        </div>

        {/* Steps */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {steps.map((step, index) => (
            <div key={step.step} className="relative">
              {/* Connector line */}
              {index < steps.length - 1 && (
                <div className="hidden lg:block absolute top-12 left-1/2 w-full h-0.5 bg-gray-200" />
              )}

              <div className="relative bg-white rounded-2xl p-6 shadow-sm border hover:shadow-md transition-shadow">
                {/* Step number */}
                <div className="absolute -top-3 left-6 px-3 py-1 bg-primary text-white text-xs font-bold rounded-full">
                  {step.step}
                </div>

                {/* Icon */}
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mt-2 mb-4">
                  <step.icon className="w-6 h-6 text-primary" />
                </div>

                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  {step.title}
                </h3>
                <p className="text-gray-600 text-sm leading-relaxed">
                  {step.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

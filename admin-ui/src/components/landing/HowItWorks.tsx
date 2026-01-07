import { Upload, Brain, Send, BarChart } from 'lucide-react';

const steps = [
  {
    icon: Upload,
    step: '01',
    title: 'Upload Your Targets',
    description: 'Import your prospect list from CSV or connect your CRM. Just need an email and optionally a LinkedIn URL.',
  },
  {
    icon: Brain,
    step: '02',
    title: 'AI Does Research',
    description: 'Envoy researches each prospect - their role, company, recent news, and finds relevant conversation starters.',
  },
  {
    icon: Send,
    step: '03',
    title: 'Review & Send',
    description: 'Preview AI-generated emails, make any tweaks, then send immediately or schedule for optimal times.',
  },
  {
    icon: BarChart,
    step: '04',
    title: 'Track Results',
    description: 'Monitor opens, clicks, and replies in real-time. AI learns from what works to improve future emails.',
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
            From prospect list to personalized outreach in four simple steps.
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

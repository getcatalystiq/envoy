import {
  Brain,
  Target,
  Zap,
  BarChart3,
  Shield,
  RefreshCw
} from 'lucide-react';

const features = [
  {
    icon: Brain,
    title: 'AI Research',
    description: 'Automatically researches prospects using LinkedIn, company websites, and news to find relevant talking points.',
  },
  {
    icon: Target,
    title: 'Hyper-Personalization',
    description: 'Every email is unique, referencing specific details about the recipient and their company.',
  },
  {
    icon: Zap,
    title: 'Instant Generation',
    description: 'Generate hundreds of personalized emails in minutes, not hours. Scale your outreach effortlessly.',
  },
  {
    icon: BarChart3,
    title: 'Smart Analytics',
    description: 'Track opens, clicks, and replies. AI learns from your best-performing emails to improve over time.',
  },
  {
    icon: Shield,
    title: 'Deliverability First',
    description: 'Built-in warmup, domain reputation monitoring, and smart sending schedules to land in the inbox.',
  },
  {
    icon: RefreshCw,
    title: 'A/B Testing',
    description: 'Automatically test subject lines and email variations. Let AI pick the winners.',
  },
];

export function Features() {
  return (
    <section id="features" className="py-24 bg-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Everything you need to scale outreach
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Envoy combines AI research, personalization, and deliverability tools
            to help you book more meetings with less effort.
          </p>
        </div>

        {/* Feature grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <div
              key={feature.title}
              className="p-6 rounded-2xl border bg-gray-50/50 hover:bg-white hover:shadow-lg transition-all duration-300 animate-fade-in-up"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                <feature.icon className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                {feature.title}
              </h3>
              <p className="text-gray-600 leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

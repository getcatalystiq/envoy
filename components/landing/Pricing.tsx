'use client';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

const plans = [
  {
    name: 'Starter',
    price: '$49',
    period: '/month',
    description: 'Perfect for individual sales reps getting started.',
    features: [
      '500 emails/month',
      'AI personalization',
      'LinkedIn research',
      'Basic analytics',
      'Email support',
    ],
    cta: 'Start Free Trial',
    highlighted: false,
  },
  {
    name: 'Professional',
    price: '$149',
    period: '/month',
    description: 'For growing teams that need more power.',
    features: [
      '2,500 emails/month',
      'Everything in Starter',
      'A/B testing',
      'Advanced analytics',
      'CRM integrations',
      'Priority support',
    ],
    cta: 'Start Free Trial',
    highlighted: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    description: 'For large teams with custom requirements.',
    features: [
      'Unlimited emails',
      'Everything in Professional',
      'Custom AI training',
      'Dedicated success manager',
      'SSO & security features',
      'Custom integrations',
    ],
    cta: 'Contact Sales',
    highlighted: false,
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="py-24 bg-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Simple, transparent pricing
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Start free and scale as you grow. All plans include a 14-day free trial.
          </p>
        </div>

        {/* Pricing cards */}
        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`rounded-2xl p-8 ${
                plan.highlighted
                  ? 'bg-primary text-white ring-4 ring-primary/20 scale-105'
                  : 'bg-muted border'
              }`}
            >
              <h3 className={`text-lg font-semibold mb-2 ${plan.highlighted ? 'text-white' : 'text-foreground'}`}>
                {plan.name}
              </h3>
              <div className="flex items-baseline gap-1 mb-2">
                <span className={`text-4xl font-bold ${plan.highlighted ? 'text-white' : 'text-foreground'}`}>
                  {plan.price}
                </span>
                {plan.period && (
                  <span className={plan.highlighted ? 'text-white/80' : 'text-muted-foreground'}>
                    {plan.period}
                  </span>
                )}
              </div>
              <p className={`text-sm mb-6 ${plan.highlighted ? 'text-white/80' : 'text-muted-foreground'}`}>
                {plan.description}
              </p>

              <ul className="space-y-3 mb-8">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-3 text-sm">
                    <Check className={`w-5 h-5 flex-shrink-0 ${plan.highlighted ? 'text-white' : 'text-primary'}`} />
                    <span className={plan.highlighted ? 'text-white' : 'text-foreground'}>
                      {feature}
                    </span>
                  </li>
                ))}
              </ul>

              <Button
                className={`w-full ${
                  plan.highlighted
                    ? 'bg-background text-primary hover:bg-muted'
                    : ''
                }`}
                variant={plan.highlighted ? 'secondary' : 'default'}
                asChild
              >
                <Link href="/login">{plan.cta}</Link>
              </Button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

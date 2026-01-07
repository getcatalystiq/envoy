import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

export function CTA() {
  return (
    <section className="py-24 bg-primary">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
          Ready to 10x your outreach?
        </h2>
        <p className="text-lg text-white/80 mb-8 max-w-2xl mx-auto">
          Join thousands of sales teams using Envoy to send personalized emails at scale.
          Start your free trial today.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button
            size="lg"
            className="bg-white text-primary hover:bg-gray-100 text-base px-8 py-6"
            asChild
          >
            <Link to="/login">
              Start Free Trial
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="border-white/40 text-white hover:bg-white/10 text-base px-8 py-6"
            asChild
          >
            <a href="mailto:sales@envoy.app">Talk to Sales</a>
          </Button>
        </div>
        <p className="text-sm text-white/60 mt-6">
          No credit card required. 50 free emails to start.
        </p>
      </div>
    </section>
  );
}

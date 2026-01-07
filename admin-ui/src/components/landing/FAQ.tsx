import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

const faqs = [
  {
    question: 'How does Envoy personalize emails?',
    answer: 'Envoy uses AI to research each prospect by analyzing their LinkedIn profile, company website, recent news, and social media. It then generates emails that reference specific, relevant details about the recipient and their company.',
  },
  {
    question: 'Will my emails end up in spam?',
    answer: 'We take deliverability seriously. Envoy includes domain warmup, reputation monitoring, smart sending schedules, and follows best practices to maximize inbox placement. We also provide guidance on setting up proper email authentication (SPF, DKIM, DMARC).',
  },
  {
    question: 'Can I edit the AI-generated emails?',
    answer: 'Absolutely! Every email can be reviewed and edited before sending. You can modify the subject line, body, or any details. The AI learns from your edits to improve future generations.',
  },
  {
    question: 'What integrations do you support?',
    answer: 'Envoy integrates with popular CRMs like Salesforce, HubSpot, and Pipedrive. We also support importing prospects from CSV files and connecting with LinkedIn Sales Navigator.',
  },
  {
    question: 'Is there a free trial?',
    answer: 'Yes! All plans come with a 14-day free trial. You get 50 free emails to test the platform with no credit card required. After the trial, you can choose a plan that fits your needs.',
  },
  {
    question: 'How is this different from other email tools?',
    answer: 'Unlike mail merge tools that insert basic variables, Envoy does deep research on each prospect and writes truly unique emails. Each message references specific details that show you did your homework, leading to much higher response rates.',
  },
];

export function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" className="py-24 bg-gray-50">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Frequently Asked Questions
          </h2>
          <p className="text-lg text-gray-600">
            Got questions? We have answers.
          </p>
        </div>

        {/* FAQ list */}
        <div className="space-y-4">
          {faqs.map((faq, index) => (
            <div
              key={index}
              className="bg-white rounded-xl border overflow-hidden"
            >
              <button
                className="w-full px-6 py-4 flex items-center justify-between text-left"
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
              >
                <span className="font-medium text-gray-900">{faq.question}</span>
                <ChevronDown
                  className={cn(
                    'w-5 h-5 text-gray-500 transition-transform',
                    openIndex === index && 'rotate-180'
                  )}
                />
              </button>
              {openIndex === index && (
                <div className="px-6 pb-4">
                  <p className="text-gray-600 leading-relaxed">{faq.answer}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

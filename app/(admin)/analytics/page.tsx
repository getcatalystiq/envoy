'use client';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, type Analytics as AnalyticsType } from '@/lib/api';
import {
  Mail,
  MousePointer,
  TrendingUp,
  MessageSquare,
  Users,
  Target,
} from 'lucide-react';

export default function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<AnalyticsType | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadAnalytics();
  }, []);

  const loadAnalytics = async () => {
    try {
      const data = await api.get<AnalyticsType>('/analytics');
      setAnalytics(data);
    } catch (error) {
      console.error('Failed to load analytics:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!analytics) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Failed to load analytics</p>
      </div>
    );
  }

  const stats = [
    {
      name: 'Total Campaigns',
      value: analytics.total_campaigns,
      icon: Target,
      color: 'text-blue-600',
      bg: 'bg-blue-100 dark:bg-blue-900',
    },
    {
      name: 'Total Targets',
      value: analytics.total_targets.toLocaleString(),
      icon: Users,
      color: 'text-purple-600',
      bg: 'bg-purple-100 dark:bg-purple-900',
    },
    {
      name: 'Emails Sent',
      value: analytics.total_sent.toLocaleString(),
      icon: Mail,
      color: 'text-green-600',
      bg: 'bg-green-100 dark:bg-green-900',
    },
    {
      name: 'Total Replies',
      value: analytics.total_replied.toLocaleString(),
      icon: MessageSquare,
      color: 'text-orange-600',
      bg: 'bg-orange-100 dark:bg-orange-900',
    },
  ];

  const rates = [
    {
      name: 'Open Rate',
      value: analytics.open_rate,
      benchmark: 25,
      icon: MousePointer,
    },
    {
      name: 'Click Rate',
      value: analytics.click_rate,
      benchmark: 3,
      icon: TrendingUp,
    },
    {
      name: 'Reply Rate',
      value: analytics.reply_rate ?? 0,
      benchmark: 5,
      icon: MessageSquare,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Analytics</h1>
        <p className="text-muted-foreground">Track your email campaign performance</p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Card key={stat.name}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-xl ${stat.bg}`}>
                  <stat.icon className={`w-6 h-6 ${stat.color}`} />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{stat.name}</p>
                  <p className="text-2xl font-bold text-foreground">{stat.value}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Performance Rates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {rates.map((rate) => (
              <div key={rate.name}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <rate.icon className="w-4 h-4 text-muted-foreground" />
                    <span className="font-medium text-foreground">{rate.name}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-2xl font-bold text-foreground">
                      {rate.value.toFixed(1)}%
                    </span>
                    <span className="text-sm text-muted-foreground ml-2">
                      (benchmark: {rate.benchmark}%)
                    </span>
                  </div>
                </div>
                <div className="h-3 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      rate.value >= rate.benchmark ? 'bg-green-500' : 'bg-yellow-500'
                    }`}
                    style={{ width: `${Math.min(rate.value, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between mt-1 text-xs text-muted-foreground">
                  <span>0%</span>
                  <span>Industry benchmark: {rate.benchmark}%</span>
                  <span>100%</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Insights</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {analytics.open_rate > 0.25 ? (
              <div className="flex items-start gap-3 p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                <div className="w-2 h-2 rounded-full bg-green-500 mt-1.5" />
                <div>
                  <p className="font-medium text-green-800 dark:text-green-200">Great open rates!</p>
                  <p className="text-sm text-green-700 dark:text-green-300">
                    Your emails are landing in inboxes. Keep subject lines personalized and compelling.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 p-3 bg-yellow-50 dark:bg-yellow-950 rounded-lg">
                <div className="w-2 h-2 rounded-full bg-yellow-500 mt-1.5" />
                <div>
                  <p className="font-medium text-yellow-800 dark:text-yellow-200">Improve open rates</p>
                  <p className="text-sm text-yellow-700 dark:text-yellow-300">
                    Try more personalized subject lines and check your sender reputation.
                  </p>
                </div>
              </div>
            )}

            {analytics.reply_rate > 0.05 ? (
              <div className="flex items-start gap-3 p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                <div className="w-2 h-2 rounded-full bg-green-500 mt-1.5" />
                <div>
                  <p className="font-medium text-green-800 dark:text-green-200">Strong reply rates!</p>
                  <p className="text-sm text-green-700 dark:text-green-300">
                    Your personalization is working. Continue with similar messaging strategies.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
                <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5" />
                <div>
                  <p className="font-medium text-blue-800 dark:text-blue-200">Tip: Boost replies</p>
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    Add specific questions or clear calls-to-action at the end of your emails.
                  </p>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

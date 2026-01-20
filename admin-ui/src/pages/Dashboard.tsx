import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api, type Analytics } from '@/api/client';
import { EmailMetricsChart } from '@/components/EmailMetricsChart';
import {
  Mail,
  MousePointer,
  MessageSquare,
  TrendingUp,
  Plus,
} from 'lucide-react';

export function Dashboard() {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadAnalytics();
  }, []);

  const loadAnalytics = async () => {
    try {
      const data = await api.get<Analytics>('/analytics');
      setAnalytics(data);
    } catch (error) {
      console.error('Failed to load analytics:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const stats = analytics
    ? [
        {
          name: 'Total Sent',
          value: analytics.total_sent.toLocaleString(),
          icon: Mail,
          color: 'text-blue-600',
          bg: 'bg-blue-100',
        },
        {
          name: 'Open Rate',
          value: `${(analytics.open_rate * 100).toFixed(1)}%`,
          icon: MousePointer,
          color: 'text-green-600',
          bg: 'bg-green-100',
        },
        {
          name: 'Click Rate',
          value: `${(analytics.click_rate * 100).toFixed(1)}%`,
          icon: TrendingUp,
          color: 'text-purple-600',
          bg: 'bg-purple-100',
        },
        {
          name: 'Reply Rate',
          value: `${(analytics.reply_rate * 100).toFixed(1)}%`,
          icon: MessageSquare,
          color: 'text-orange-600',
          bg: 'bg-orange-100',
        },
      ]
    : [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-600">Overview of your email campaigns</p>
        </div>
        <Button asChild>
          <Link to="/campaigns">
            <Plus className="w-4 h-4 mr-2" />
            New Campaign
          </Link>
        </Button>
      </div>

      {/* Stats grid */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Card key={stat.name}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className={`p-3 rounded-xl ${stat.bg}`}>
                  <stat.icon className={`w-6 h-6 ${stat.color}`} />
                </div>
                <div>
                  <p className="text-sm text-gray-600">{stat.name}</p>
                  <p className="text-2xl font-bold text-gray-900">{stat.value}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Email Metrics Charts */}
      <EmailMetricsChart />
    </div>
  );
}

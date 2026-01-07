import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api, type Analytics } from '@/api/client';
import {
  Mail,
  Users,
  MousePointer,
  MessageSquare,
  TrendingUp,
  ArrowRight,
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

      {/* Quick actions */}
      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Link
              to="/targets"
              className="flex items-center justify-between p-3 rounded-lg border hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Users className="w-5 h-5 text-gray-500" />
                <span>Upload new targets</span>
              </div>
              <ArrowRight className="w-4 h-4 text-gray-400" />
            </Link>
            <Link
              to="/content"
              className="flex items-center justify-between p-3 rounded-lg border hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Mail className="w-5 h-5 text-gray-500" />
                <span>Create email template</span>
              </div>
              <ArrowRight className="w-4 h-4 text-gray-400" />
            </Link>
            <Link
              to="/campaigns"
              className="flex items-center justify-between p-3 rounded-lg border hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <TrendingUp className="w-5 h-5 text-gray-500" />
                <span>Launch a campaign</span>
              </div>
              <ArrowRight className="w-4 h-4 text-gray-400" />
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-primary">1</span>
                </div>
                <div>
                  <p className="font-medium text-gray-900">Upload your prospects</p>
                  <p className="text-sm text-gray-600">Import a CSV with email addresses and LinkedIn URLs</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-primary">2</span>
                </div>
                <div>
                  <p className="font-medium text-gray-900">Create a content template</p>
                  <p className="text-sm text-gray-600">Set up your email structure with dynamic placeholders</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-primary">3</span>
                </div>
                <div>
                  <p className="font-medium text-gray-900">Launch your campaign</p>
                  <p className="text-sm text-gray-600">Review AI-generated emails and start sending</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

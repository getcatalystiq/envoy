import { useState, useEffect, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { RefreshCw, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { MetricSelector, type MetricOption } from '@/components/MetricSelector';
import { getMetrics, type TimeSeriesDataPoint } from '@/api/client';

// Color palette for metrics
const METRIC_COLORS = {
  sent: '#3B82F6', // Blue
  delivered: '#22C55E', // Green
  complaints: '#F43F5E', // Rose
  transient_bounces: '#F59E0B', // Amber
  permanent_bounces: '#EF4444', // Red
  opens: '#6366F1', // Indigo
  clicks: '#06B6D4', // Cyan
} as const;

const VOLUME_METRICS: MetricOption[] = [
  { id: 'sent', label: 'Sent', color: METRIC_COLORS.sent },
  { id: 'delivered', label: 'Delivered', color: METRIC_COLORS.delivered },
  { id: 'complaints', label: 'Complaints', color: METRIC_COLORS.complaints },
  {
    id: 'transient_bounces',
    label: 'Transient bounces',
    color: METRIC_COLORS.transient_bounces,
  },
  {
    id: 'permanent_bounces',
    label: 'Permanent bounces',
    color: METRIC_COLORS.permanent_bounces,
  },
  { id: 'opens', label: 'Opens', color: METRIC_COLORS.opens },
  { id: 'clicks', label: 'Clicks', color: METRIC_COLORS.clicks },
];

interface ChartDataPoint extends TimeSeriesDataPoint {
  bucket: string;
  delivery_rate: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  complaint_rate: number;
}

function formatBucket(timestamp: string, granularity: 'hourly' | 'daily'): string {
  const date = new Date(timestamp);
  if (granularity === 'hourly') {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface TooltipPayloadEntry {
  dataKey?: string;
  name?: string;
  value?: number;
  color?: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;

  return (
    <div className="rounded-lg border bg-white p-3 shadow-lg">
      <p className="mb-2 text-sm font-medium text-gray-900">{label}</p>
      {payload.map((entry: TooltipPayloadEntry) => (
        <div key={entry.dataKey} className="flex items-center gap-2 text-sm">
          <span
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-gray-600">{entry.name}:</span>
          <span className="font-medium text-gray-900">
            {typeof entry.value === 'number'
              ? entry.dataKey?.includes('rate')
                ? `${entry.value.toFixed(1)}%`
                : entry.value.toLocaleString()
              : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatYAxisNumber(value: number): string {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return value.toString();
}

export function EmailMetricsChart() {
  const [data, setData] = useState<TimeSeriesDataPoint[]>([]);
  const [granularity, setGranularity] = useState<'hourly' | 'daily'>('daily');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(
    VOLUME_METRICS.map((m) => m.id)
  );

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getMetrics();
      setData(response.data);
      setGranularity(response.meta.granularity);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load metrics');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Calculate rates and format data for charts
  const chartData: ChartDataPoint[] = useMemo(() => {
    return data.map((point) => ({
      ...point,
      bucket: formatBucket(point.timestamp, granularity),
      delivery_rate:
        point.sent > 0 ? (point.delivered / point.sent) * 100 : 0,
      open_rate:
        point.delivered > 0 ? (point.opens / point.delivered) * 100 : 0,
      click_rate: point.opens > 0 ? (point.clicks / point.opens) * 100 : 0,
      bounce_rate:
        point.sent > 0
          ? ((point.transient_bounces + point.permanent_bounces) / point.sent) *
            100
          : 0,
      complaint_rate:
        point.sent > 0 ? (point.complaints / point.sent) * 100 : 0,
    }));
  }, [data, granularity]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex h-[400px] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary"></div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex h-[400px] flex-col items-center justify-center gap-4">
          <p className="text-gray-600">{error}</p>
          <Button onClick={loadData} variant="outline">
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardContent className="flex h-[400px] flex-col items-center justify-center gap-2">
          <p className="text-gray-600">No email activity in this period</p>
          <p className="text-sm text-gray-400">
            Send some emails to see metrics here
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-lg font-semibold">Metrics</CardTitle>
            <TooltipProvider>
              <UITooltip>
                <TooltipTrigger asChild>
                  <button className="text-blue-600 hover:text-blue-700">
                    <Info className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-sm">
                    <strong>Volume</strong>: Raw counts of email events
                    <br />
                    <strong>Rate</strong>: Percentages (delivery = delivered/sent,
                    open = opens/delivered, click = clicks/opens)
                  </p>
                </TooltipContent>
              </UITooltip>
            </TooltipProvider>
          </div>
          <div className="flex items-center gap-2">
            <MetricSelector
              metrics={VOLUME_METRICS}
              selected={selectedMetrics}
              onChange={setSelectedMetrics}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={loadData}
              disabled={isLoading}
            >
              <RefreshCw
                className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`}
              />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {selectedMetrics.length === 0 ? (
          <div className="flex h-[300px] items-center justify-center text-gray-500">
            Select metrics to display
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Volume Chart */}
            <div>
              <h3 className="mb-4 text-sm font-medium text-gray-700">Volume</h3>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart
                  data={chartData}
                  margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                  <XAxis
                    dataKey="bucket"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: '#E5E7EB' }}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: '#E5E7EB' }}
                    tickFormatter={formatYAxisNumber}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  {selectedMetrics.includes('sent') && (
                    <Line
                      type="monotone"
                      dataKey="sent"
                      name="Sent"
                      stroke={METRIC_COLORS.sent}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                  {selectedMetrics.includes('delivered') && (
                    <Line
                      type="monotone"
                      dataKey="delivered"
                      name="Delivered"
                      stroke={METRIC_COLORS.delivered}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                  {selectedMetrics.includes('complaints') && (
                    <Line
                      type="monotone"
                      dataKey="complaints"
                      name="Complaints"
                      stroke={METRIC_COLORS.complaints}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                  {selectedMetrics.includes('transient_bounces') && (
                    <Line
                      type="monotone"
                      dataKey="transient_bounces"
                      name="Transient bounces"
                      stroke={METRIC_COLORS.transient_bounces}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                  {selectedMetrics.includes('permanent_bounces') && (
                    <Line
                      type="monotone"
                      dataKey="permanent_bounces"
                      name="Permanent bounces"
                      stroke={METRIC_COLORS.permanent_bounces}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                  {selectedMetrics.includes('opens') && (
                    <Line
                      type="monotone"
                      dataKey="opens"
                      name="Opens"
                      stroke={METRIC_COLORS.opens}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                  {selectedMetrics.includes('clicks') && (
                    <Line
                      type="monotone"
                      dataKey="clicks"
                      name="Clicks"
                      stroke={METRIC_COLORS.clicks}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Rate Chart */}
            <div>
              <h3 className="mb-4 text-sm font-medium text-gray-700">Rate</h3>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart
                  data={chartData}
                  margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                  <XAxis
                    dataKey="bucket"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: '#E5E7EB' }}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: '#E5E7EB' }}
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  {selectedMetrics.includes('delivered') && (
                    <Line
                      type="monotone"
                      dataKey="delivery_rate"
                      name="Delivery rate"
                      stroke={METRIC_COLORS.delivered}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                  {selectedMetrics.includes('opens') && (
                    <Line
                      type="monotone"
                      dataKey="open_rate"
                      name="Open rate"
                      stroke={METRIC_COLORS.opens}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                  {selectedMetrics.includes('clicks') && (
                    <Line
                      type="monotone"
                      dataKey="click_rate"
                      name="Click rate"
                      stroke={METRIC_COLORS.clicks}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                  {(selectedMetrics.includes('transient_bounces') ||
                    selectedMetrics.includes('permanent_bounces')) && (
                    <Line
                      type="monotone"
                      dataKey="bounce_rate"
                      name="Bounce rate"
                      stroke={METRIC_COLORS.permanent_bounces}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                  {selectedMetrics.includes('complaints') && (
                    <Line
                      type="monotone"
                      dataKey="complaint_rate"
                      name="Complaint rate"
                      stroke={METRIC_COLORS.complaints}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

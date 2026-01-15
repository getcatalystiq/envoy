import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/api/client';
import { CheckCircle, XCircle, Loader2, Zap, Users, Tags, AtSign } from 'lucide-react';
import { TargetTypesList } from './TargetTypes';
import { SegmentsList } from './Segments';
import { EmailSettings } from './EmailSettings';

interface SetupStatus {
  maven_configured: boolean;
  skills_provisioned_at: string | null;
  skills_status: Record<string, string> | null;
}

const SKILLS = [
  { slug: 'envoy-content-generation', name: 'Content Generation', description: 'Generate personalized content' },
];

function MavenSkillsTab() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    try {
      const data = await api.get<SetupStatus>('/setup/status');
      setStatus(data);
    } catch {
      setError('Failed to load setup status');
    } finally {
      setIsLoading(false);
    }
  };

  const provisionSkills = async () => {
    setIsProvisioning(true);
    setError(null);
    try {
      await api.post('/setup/provision-skills');
      await loadStatus();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to provision skills';
      setError(message);
    } finally {
      setIsProvisioning(false);
    }
  };

  const getSkillStatus = (slug: string) => {
    if (!status?.skills_status) return 'pending';
    return status.skills_status[slug] || 'pending';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="w-5 h-5" />
          Maven Skills
        </CardTitle>
        <CardDescription>
          Envoy requires these AI skills to generate personalized content
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Skills List */}
        <div className="space-y-3">
          {SKILLS.map((skill) => {
            const skillStatus = getSkillStatus(skill.slug);
            return (
              <div key={skill.slug} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div>
                  <p className="font-medium">{skill.name}</p>
                  <p className="text-sm text-gray-600">{skill.description}</p>
                </div>
                <Badge variant={
                  skillStatus === 'success' ? 'default' :
                  skillStatus === 'error' ? 'destructive' : 'secondary'
                }>
                  {skillStatus === 'success' && <CheckCircle className="w-3 h-3 mr-1" />}
                  {skillStatus === 'error' && <XCircle className="w-3 h-3 mr-1" />}
                  {skillStatus === 'success' ? 'Active' :
                   skillStatus === 'error' ? 'Failed' : 'Not Provisioned'}
                </Badge>
              </div>
            );
          })}
        </div>

        {/* Error Message */}
        {error && (
          <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Provision Button */}
        <Button
          onClick={provisionSkills}
          disabled={isProvisioning || !status?.maven_configured}
          className="w-full"
        >
          {isProvisioning ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Provisioning Skills...
            </>
          ) : status?.skills_provisioned_at ? (
            'Re-provision Skills'
          ) : (
            'Provision Skills'
          )}
        </Button>

        {!status?.maven_configured && (
          <p className="text-sm text-amber-600 text-center">
            Maven tenant ID not configured for this organization
          </p>
        )}

        {status?.skills_provisioned_at && (
          <p className="text-sm text-gray-500 text-center">
            Last provisioned: {new Date(status.skills_provisioned_at).toLocaleString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'email';

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-600">Configure your organization settings</p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="email" className="flex items-center gap-2">
            <AtSign className="w-4 h-4" />
            Email
          </TabsTrigger>
          <TabsTrigger value="target-types" className="flex items-center gap-2">
            <Users className="w-4 h-4" />
            Target Types
          </TabsTrigger>
          <TabsTrigger value="segments" className="flex items-center gap-2">
            <Tags className="w-4 h-4" />
            Segments
          </TabsTrigger>
          <TabsTrigger value="maven-skills" className="flex items-center gap-2">
            <Zap className="w-4 h-4" />
            Maven Skills
          </TabsTrigger>
        </TabsList>

        <TabsContent value="email" className="mt-6">
          <EmailSettings />
        </TabsContent>

        <TabsContent value="target-types" className="mt-6">
          <TargetTypesList />
        </TabsContent>

        <TabsContent value="segments" className="mt-6">
          <SegmentsList />
        </TabsContent>

        <TabsContent value="maven-skills" className="mt-6">
          <MavenSkillsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

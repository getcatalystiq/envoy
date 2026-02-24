'use client';
import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth-context';
import {
  getOrganization,
  updateOrganization,
  checkDomainVerificationStatus,
  type OrganizationSettings,
} from '@/lib/api';
import { Loader2, Copy, CheckCircle, AtSign } from 'lucide-react';

const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const validateDomain = (domain: string): string | null => {
  if (!domain) return null;
  const normalized = domain.toLowerCase().trim();
  if (!DOMAIN_REGEX.test(normalized)) {
    return 'Enter a valid domain (e.g., mail.company.com)';
  }
  return null;
};

export function EmailSettings() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [settings, setSettings] = useState<OrganizationSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [verifyCooldown, setVerifyCooldown] = useState(0);

  const [emailDomain, setEmailDomain] = useState('');
  const [emailFromName, setEmailFromName] = useState('');

  const domainError = useMemo(() => validateDomain(emailDomain), [emailDomain]);

  const isDirty = useMemo(() => {
    if (!settings) return false;
    return (
      emailDomain !== (settings.email_domain || '') ||
      emailFromName !== (settings.email_from_name || '')
    );
  }, [settings, emailDomain, emailFromName]);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    if (verifyCooldown > 0) {
      const timer = setTimeout(() => setVerifyCooldown(verifyCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [verifyCooldown]);

  const loadSettings = async () => {
    try {
      const data = await getOrganization();
      setSettings(data);
      setEmailDomain(data.email_domain || '');
      setEmailFromName(data.email_from_name || '');
    } catch {
      setError('Failed to load organization settings');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (domainError) return;

    if (settings?.email_domain_verified && emailDomain !== settings.email_domain) {
      if (!window.confirm('Changing your domain will require re-verification. Continue?')) {
        return;
      }
    }

    setIsSaving(true);
    setError(null);
    try {
      const data = await updateOrganization({
        email_domain: emailDomain || undefined,
        email_from_name: emailFromName || undefined,
      });
      setSettings(data);
      setSuccess('Settings saved');
      setTimeout(() => setSuccess(null), 2000);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('403')) {
        setError('Admin access required to change email domain');
      } else {
        const message = err instanceof Error ? err.message : 'Failed to save settings';
        setError(message);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    setError(null);
    try {
      const data = await checkDomainVerificationStatus();
      setSettings(data);
      if (data.email_domain_verified) {
        setSuccess('Domain verified!');
      } else {
        setSuccess('Verification pending. Please ensure DNS records are configured.');
      }
      setTimeout(() => setSuccess(null), 3000);
      setVerifyCooldown(30);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('403')) {
        setError('Admin access required to verify domain');
      } else {
        const message = err instanceof Error ? err.message : 'Failed to check verification';
        setError(message);
      }
    } finally {
      setIsVerifying(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSuccess('Copied to clipboard');
    } catch {
      setError('Failed to copy. Please select and copy manually.');
    }
    setTimeout(() => setSuccess(null), 2000);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AtSign className="w-5 h-5" />
            Email Domain
          </CardTitle>
          <CardDescription>
            Set up a custom domain to send emails from your organization
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="email-domain">Domain</Label>
              <Input
                id="email-domain"
                value={emailDomain}
                onChange={(e) => setEmailDomain(e.target.value.toLowerCase())}
                placeholder="mail.company.com"
                disabled={isSaving || !isAdmin}
                title={!isAdmin ? 'Admin access required' : undefined}
              />
              {domainError && (
                <p className="text-sm text-red-600">{domainError}</p>
              )}
              {!isAdmin && (
                <p className="text-sm text-amber-600">Admin access required</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="from-name">From Name</Label>
              <Input
                id="from-name"
                value={emailFromName}
                onChange={(e) => setEmailFromName(e.target.value)}
                placeholder="noreply"
                maxLength={100}
                disabled={isSaving}
              />
              <p className="text-sm text-gray-500">
                Emails will be sent from {emailFromName || 'noreply'}@{emailDomain || 'your-domain.com'}
              </p>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="p-3 bg-green-50 text-green-700 rounded-lg text-sm flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              {success}
            </div>
          )}

          <Button
            onClick={handleSave}
            disabled={isSaving || !isDirty || !!domainError}
            className="w-full"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Settings'
            )}
          </Button>
        </CardContent>
      </Card>

      {settings?.email_domain && settings.dns_records.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>DNS Records</CardTitle>
                <CardDescription>
                  Add these records to your domain&apos;s DNS configuration
                </CardDescription>
              </div>
              <Badge variant={settings.email_domain_verified ? 'default' : 'secondary'}>
                {settings.email_domain_verified ? 'Verified' : 'Pending'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4 font-medium">Type</th>
                    <th className="text-left py-2 pr-4 font-medium">Name</th>
                    <th className="text-left py-2 font-medium">Value</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {/* DKIM Records */}
                  {settings.dns_records.filter(r => r.type === 'CNAME').length > 0 && (
                    <tr>
                      <td colSpan={4} className="py-2 pt-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        DKIM (Email Authentication)
                      </td>
                    </tr>
                  )}
                  {settings.dns_records.filter(r => r.type === 'CNAME').map((record, idx) => (
                    <tr key={`cname-${idx}`} className="border-b">
                      <td className="py-2 pr-4">
                        <Badge variant="outline">{record.type}</Badge>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs break-all">
                        {record.name}
                      </td>
                      <td className="py-2 font-mono text-xs break-all">
                        {record.value}
                      </td>
                      <td className="py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyToClipboard(record.value)}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {/* MAIL FROM Records */}
                  {settings.dns_records.filter(r => r.type === 'MX' || (r.type === 'TXT' && r.name.startsWith('mail.'))).length > 0 && (
                    <tr>
                      <td colSpan={4} className="py-2 pt-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        MAIL FROM (Bounce Handling)
                      </td>
                    </tr>
                  )}
                  {settings.dns_records.filter(r => r.type === 'MX' || (r.type === 'TXT' && r.name.startsWith('mail.'))).map((record, idx) => (
                    <tr key={`mailfrom-${idx}`} className="border-b">
                      <td className="py-2 pr-4">
                        <Badge variant="outline">{record.type}</Badge>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs break-all">
                        {record.name}
                      </td>
                      <td className="py-2 font-mono text-xs break-all">
                        {record.value}
                      </td>
                      <td className="py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyToClipboard(record.value)}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {/* DMARC Record */}
                  {settings.dns_records.filter(r => r.type === 'TXT' && r.name.startsWith('_dmarc.')).length > 0 && (
                    <tr>
                      <td colSpan={4} className="py-2 pt-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        DMARC (Email Policy)
                      </td>
                    </tr>
                  )}
                  {settings.dns_records.filter(r => r.type === 'TXT' && r.name.startsWith('_dmarc.')).map((record, idx) => (
                    <tr key={`dmarc-${idx}`} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        <Badge variant="outline">{record.type}</Badge>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs break-all">
                        {record.name}
                      </td>
                      <td className="py-2 font-mono text-xs break-all">
                        {record.value}
                      </td>
                      <td className="py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyToClipboard(record.value)}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!settings.email_domain_verified && (
              <Button
                onClick={handleVerify}
                disabled={isVerifying || verifyCooldown > 0 || !isAdmin}
                variant="outline"
                className="w-full"
                title={!isAdmin ? 'Admin access required' : undefined}
              >
                {isVerifying ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Checking...
                  </>
                ) : verifyCooldown > 0 ? (
                  `Check Verification (${verifyCooldown}s)`
                ) : (
                  'Check Verification'
                )}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

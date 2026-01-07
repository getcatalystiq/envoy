import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api, type ContentTemplate } from '@/api/client';
import { Plus, FileText, Edit, Trash2 } from 'lucide-react';

export function Content() {
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      const data = await api.get<ContentTemplate[]>('/content');
      setTemplates(data);
    } catch (error) {
      console.error('Failed to load templates:', error);
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Content Templates</h1>
          <p className="text-gray-600">Manage your email templates</p>
        </div>
        <Button>
          <Plus className="w-4 h-4 mr-2" />
          New Template
        </Button>
      </div>

      {/* Templates list */}
      {templates.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No templates yet</h3>
            <p className="text-gray-600 mb-4">Create your first email template to use in campaigns</p>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Create Template
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {templates.map((template) => (
            <Card key={template.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">{template.name}</CardTitle>
                    {template.variant_label && (
                      <Badge variant="secondary">{template.variant_label}</Badge>
                    )}
                  </div>
                  <Badge variant={template.is_active ? 'success' : 'outline'}>
                    {template.is_active ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Subject</p>
                    <p className="text-sm text-gray-700 truncate">{template.subject_template}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Preview</p>
                    <p className="text-sm text-gray-600 line-clamp-2">
                      {template.body_template.substring(0, 150)}...
                    </p>
                  </div>
                  <div className="flex items-center gap-2 pt-2">
                    <Button variant="outline" size="sm">
                      <Edit className="w-3 h-3 mr-1" />
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 hover:bg-red-50">
                      <Trash2 className="w-3 h-3 mr-1" />
                      Delete
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Template guide */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Template Variables</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 mb-4">
            Use these variables in your templates. AI will fill them with personalized content:
          </p>
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <div className="flex items-center gap-2">
              <code className="px-2 py-1 bg-gray-100 rounded text-primary">{'{{first_name}}'}</code>
              <span className="text-gray-600">Recipient's first name</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="px-2 py-1 bg-gray-100 rounded text-primary">{'{{company}}'}</code>
              <span className="text-gray-600">Company name</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="px-2 py-1 bg-gray-100 rounded text-primary">{'{{title}}'}</code>
              <span className="text-gray-600">Job title</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="px-2 py-1 bg-gray-100 rounded text-primary">{'{{personalization}}'}</code>
              <span className="text-gray-600">AI-generated personalization</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, type ContentTemplate } from '@/api/client';
import { Plus, FileText, Edit, Trash2, X } from 'lucide-react';

const CONTENT_TYPES = [
  { value: 'educational', label: 'Educational' },
  { value: 'case_study', label: 'Case Study' },
  { value: 'promotional', label: 'Promotional' },
  { value: 'objection_handling', label: 'Objection Handling' },
  { value: 'product_update', label: 'Product Update' },
];

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'twitter', label: 'Twitter' },
  { value: 'blog', label: 'Blog' },
  { value: 'instagram', label: 'Instagram' },
];

interface ContentFormData {
  name: string;
  content_type: string;
  channel: string;
  subject: string;
  body: string;
}

const defaultFormData: ContentFormData = {
  name: '',
  content_type: 'educational',
  channel: 'email',
  subject: '',
  body: '',
};

export function Content() {
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ContentTemplate | null>(null);
  const [formData, setFormData] = useState<ContentFormData>(defaultFormData);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      const data = await api.get<{ items: ContentTemplate[]; total: number }>('/content');
      setTemplates(data.items || []);
    } catch (error) {
      console.error('Failed to load templates:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const openCreateModal = () => {
    setEditingTemplate(null);
    setFormData(defaultFormData);
    setIsModalOpen(true);
  };

  const openEditModal = (template: ContentTemplate) => {
    setEditingTemplate(template);
    setFormData({
      name: template.name,
      content_type: template.content_type,
      channel: template.channel,
      subject: template.subject || '',
      body: template.body,
    });
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingTemplate(null);
    setFormData(defaultFormData);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const payload = {
        ...formData,
        subject: formData.subject || null,
      };

      if (editingTemplate) {
        await api.patch(`/content/${editingTemplate.id}`, payload);
      } else {
        await api.post('/content', payload);
      }
      await loadTemplates();
      closeModal();
    } catch (error) {
      console.error('Failed to save content:', error);
      alert('Failed to save content. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/content/${id}`);
      await loadTemplates();
      setDeleteConfirmId(null);
    } catch (error) {
      console.error('Failed to delete content:', error);
      alert('Failed to delete content. Please try again.');
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
        <Button onClick={openCreateModal}>
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
            <Button onClick={openCreateModal}>
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
                    <Badge variant="secondary">{template.content_type.replace('_', ' ')}</Badge>
                  </div>
                  <Badge variant={template.status === 'active' ? 'success' : 'outline'}>
                    {template.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {template.subject && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">Subject</p>
                      <p className="text-sm text-gray-700 truncate">{template.subject}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Preview</p>
                    <p className="text-sm text-gray-600 line-clamp-2">
                      {template.body.substring(0, 150)}...
                    </p>
                  </div>
                  <div className="flex items-center gap-2 pt-2">
                    <Button variant="outline" size="sm" onClick={() => openEditModal(template)}>
                      <Edit className="w-3 h-3 mr-1" />
                      Edit
                    </Button>
                    {deleteConfirmId === template.id ? (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDelete(template.id)}
                        >
                          Confirm
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteConfirmId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => setDeleteConfirmId(template.id)}
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        Delete
                      </Button>
                    )}
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

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={closeModal} />
          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">
                {editingTemplate ? 'Edit Content' : 'Create Content'}
              </h2>
              <Button variant="ghost" size="sm" onClick={closeModal}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              <div>
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Initial Outreach Email"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="content_type">Content Type *</Label>
                  <select
                    id="content_type"
                    value={formData.content_type}
                    onChange={(e) => setFormData({ ...formData, content_type: e.target.value })}
                    className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    required
                  >
                    {CONTENT_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="channel">Channel *</Label>
                  <select
                    id="channel"
                    value={formData.channel}
                    onChange={(e) => setFormData({ ...formData, channel: e.target.value })}
                    className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    required
                  >
                    {CHANNELS.map((ch) => (
                      <option key={ch.value} value={ch.value}>
                        {ch.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {formData.channel === 'email' && (
                <div>
                  <Label htmlFor="subject">Subject Line</Label>
                  <Input
                    id="subject"
                    value={formData.subject}
                    onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                    placeholder="e.g., Quick question about {{company}}"
                  />
                </div>
              )}
              <div>
                <Label htmlFor="body">Body *</Label>
                <Textarea
                  id="body"
                  value={formData.body}
                  onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                  placeholder="Hi {{first_name}},&#10;&#10;{{personalization}}&#10;&#10;Best regards"
                  rows={8}
                  required
                />
              </div>
              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button type="button" variant="outline" onClick={closeModal}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? 'Saving...' : (editingTemplate ? 'Update' : 'Create')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

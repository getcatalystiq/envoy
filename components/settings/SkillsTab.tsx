'use client';
/**
 * AI Skills management - list, create, edit, delete skills.
 * Skills are stored as a JSONB array on the agent via AgentPlane.
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { Plus, Edit, Trash2, Sparkles, Loader2, Code } from 'lucide-react';

interface Skill {
  name: string;
  slug: string;
  description: string | null;
  prompt: string;
}

export function SkillsTab() {
  const router = useRouter();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formPrompt, setFormPrompt] = useState('');

  useEffect(() => {
    loadSkills();
  }, []);

  const loadSkills = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.get<{ skills: Skill[] }>('/agentplane/skills');
      setSkills(data?.skills || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormSlug('');
    setFormDescription('');
    setFormPrompt('');
  };

  const openCreateDialog = () => {
    resetForm();
    setIsCreateOpen(true);
  };

  const openEditDialog = (skill: Skill) => {
    setEditingSkill(skill);
    setFormName(skill.name);
    setFormSlug(skill.slug);
    setFormDescription(skill.description || '');
    setFormPrompt(skill.prompt || '');
  };

  const handleCreate = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await api.post('/agentplane/skills', {
        name: formName,
        slug: formSlug,
        description: formDescription || null,
        prompt: formPrompt,
      });
      setIsCreateOpen(false);
      resetForm();
      await loadSkills();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingSkill) return;
    setIsSaving(true);
    setError(null);
    try {
      await api.patch(`/agentplane/skills/${encodeURIComponent(editingSkill.slug)}`, {
        name: formName,
        description: formDescription || null,
      });
      setEditingSkill(null);
      resetForm();
      await loadSkills();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (slug: string) => {
    setError(null);
    try {
      await api.delete(`/agentplane/skills/${encodeURIComponent(slug)}`);
      setDeleteConfirm(null);
      await loadSkills();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleNameChange = (name: string, isCreate: boolean) => {
    setFormName(name);
    if (isCreate) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      setFormSlug(slug);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><Sparkles className="w-5 h-5" />Skills</CardTitle>
            <CardDescription>Manage custom AI skills for your organization</CardDescription>
          </div>
          <Button onClick={openCreateDialog}><Plus className="w-4 h-4 mr-2" />New Skill</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}

        {skills.length === 0 ? (
          <div className="text-center py-8">
            <Sparkles className="w-12 h-12 mx-auto text-gray-300 mb-4" />
            <p className="text-gray-500 mb-4">No skills configured yet.</p>
            <Button onClick={openCreateDialog}><Plus className="w-4 h-4 mr-2" />Create Your First Skill</Button>
          </div>
        ) : (
          <div className="space-y-3">
            {skills.map((skill) => (
              <div key={skill.slug} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-4 flex-1 min-w-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2"><p className="font-medium truncate">{skill.name}</p></div>
                    {skill.description && <p className="text-sm text-gray-500 truncate">{skill.description}</p>}
                    <p className="text-xs text-gray-400 font-mono">{skill.slug}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <Button variant="ghost" size="sm" onClick={() => openEditDialog(skill)} title="Edit details"><Edit className="w-4 h-4" /></Button>
                  <Button variant="ghost" size="sm" onClick={() => router.push(`/settings/skills/${encodeURIComponent(skill.slug)}`)} title="Open in editor"><Code className="w-4 h-4" /></Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm(skill.slug)} title="Delete skill"><Trash2 className="w-4 h-4 text-red-500" /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Create New Skill</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div><Label htmlFor="name">Name</Label><Input id="name" value={formName} onChange={(e) => handleNameChange(e.target.value, true)} placeholder="My Custom Skill" /></div>
              <div><Label htmlFor="slug">Slug</Label><Input id="slug" value={formSlug} onChange={(e) => setFormSlug(e.target.value)} placeholder="my-custom-skill" className="font-mono" /></div>
            </div>
            <div><Label htmlFor="description">Description (optional)</Label><Input id="description" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="What does this skill do?" /></div>
            <div><Label htmlFor="prompt">Prompt</Label><Textarea id="prompt" value={formPrompt} onChange={(e) => setFormPrompt(e.target.value)} placeholder="Enter the skill prompt instructions..." className="min-h-[200px] font-mono text-sm" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!formName || !formSlug || !formPrompt || isSaving}>
              {isSaving ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating...</>) : 'Create Skill'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingSkill} onOpenChange={() => setEditingSkill(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Skill</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div><Label htmlFor="edit-name">Name</Label><Input id="edit-name" value={formName} onChange={(e) => setFormName(e.target.value)} /></div>
              <div><Label htmlFor="edit-slug">Slug</Label><Input id="edit-slug" value={formSlug} disabled className="font-mono bg-gray-50" /></div>
            </div>
            <div><Label htmlFor="edit-description">Description (optional)</Label><Input id="edit-description" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSkill(null)}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={!formName || isSaving}>
              {isSaving ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</>) : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete Skill</DialogTitle></DialogHeader>
          <p className="text-gray-600">Are you sure you want to delete this skill? This action cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

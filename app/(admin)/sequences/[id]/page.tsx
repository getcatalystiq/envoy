'use client';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  api,
  type Sequence,
  type SequenceStep,
  type Enrollment,
  type StepExecution,
  type EnrollmentStatus,
} from '@/lib/api';
import {
  ArrowLeft,
  Play,
  Archive,
  Users,
  Check,
  SkipForward,
  Pause,
  RotateCcw,
  LogOut,
  AlertCircle,
  Eye,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SequenceEmailBuilder } from '@/components/sequence-builder/SequenceEmailBuilder';
import { useLayout, MenuButton } from '@/components/Layout';
import { Reader, type TReaderDocument } from '@/components/email-builder/Reader';
import { Clock } from 'lucide-react';

const formatDelayShort = (hours: number): string => {
  if (hours === 0) return 'Now';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
};

function StepThumbnail({
  step,
  isSelected,
  onClick,
}: {
  step: SequenceStep;
  isSelected: boolean;
  onClick: () => void;
}) {
  const document = step.builder_content as TReaderDocument | null;
  const hasContent = document && Object.keys(document).length > 0 && document.root;

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-shrink-0 w-20 rounded-lg border-2 transition-all overflow-hidden',
        isSelected
          ? 'border-primary ring-2 ring-primary/20'
          : 'border-gray-200 hover:border-gray-300'
      )}
    >
      <div className="w-full h-14 bg-white relative overflow-hidden">
        {hasContent ? (
          <div
            className="absolute inset-0 origin-top-left pointer-events-none"
            style={{ transform: 'scale(0.15)', width: '666%', height: '666%' }}
          >
            <Reader document={document} rootBlockId="root" />
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gray-50">
            <span className="text-[10px] text-gray-400">Empty</span>
          </div>
        )}
      </div>
      <div className="px-1.5 py-1 bg-gray-50 border-t flex items-center justify-center gap-1">
        <Clock className="w-3 h-3 text-gray-400" />
        <span className="text-[10px] font-medium text-gray-600">
          {formatDelayShort(step.default_delay_hours)}
        </span>
      </div>
    </button>
  );
}

export default function SequenceBuilderPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const layout = useLayout();

  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [steps, setSteps] = useState<SequenceStep[]>([]);
  const [targetTypes, setTargetTypes] = useState<{ id: string; name: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'builder' | 'enrollments' | 'analytics'>('builder');

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [enrollmentFilter, setEnrollmentFilter] = useState<EnrollmentStatus | 'all'>('all');
  const [enrollmentCounts, setEnrollmentCounts] = useState({
    active: 0, paused: 0, completed: 0, converted: 0, exited: 0,
  });
  const [selectedEnrollment, setSelectedEnrollment] = useState<Enrollment | null>(null);
  const [enrollmentExecutions, setEnrollmentExecutions] = useState<StepExecution[]>([]);

  const [showArchiveDialog, setShowArchiveDialog] = useState(false);

  useEffect(() => {
    if (id) {
      loadSequence();
      loadTargetTypes();
    }
  }, [id]);

  useEffect(() => {
    if (id && activeTab === 'enrollments') {
      loadEnrollments();
    }
  }, [id, activeTab, enrollmentFilter]);

  useEffect(() => {
    if (steps.length > 0 && !selectedStepId) {
      setSelectedStepId(steps[0].id);
    }
  }, [steps, selectedStepId]);

  const loadSequence = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await api.get<Sequence>(`/sequences/${id}`);
      setSequence(data);
      setSteps(data.steps || []);
    } catch (err) {
      console.error('Failed to load sequence:', err);
      setError('Failed to load sequence');
    } finally {
      setIsLoading(false);
    }
  };

  const loadTargetTypes = async () => {
    try {
      const data = await api.get<{ id: string; name: string }[]>('/target-types');
      setTargetTypes(data || []);
    } catch (err) {
      console.error('Failed to load target types:', err);
    }
  };

  const loadEnrollments = async () => {
    try {
      const endpoint = enrollmentFilter === 'all'
        ? `/sequences/${id}/enrollments`
        : `/sequences/${id}/enrollments?status=${enrollmentFilter}`;
      const data = await api.get<{ items: Enrollment[] }>(endpoint);
      setEnrollments(data.items || []);

      const allData = await api.get<{ items: Enrollment[] }>(`/sequences/${id}/enrollments`);
      const all = allData.items || [];
      setEnrollmentCounts({
        active: all.filter((e) => e.status === 'active').length,
        paused: all.filter((e) => e.status === 'paused').length,
        completed: all.filter((e) => e.status === 'completed').length,
        converted: all.filter((e) => e.status === 'converted').length,
        exited: all.filter((e) => e.status === 'exited').length,
      });
    } catch (err) {
      console.error('Failed to load enrollments:', err);
    }
  };

  const handleActivate = async () => {
    try {
      await api.post(`/sequences/${id}/activate`);
      await loadSequence();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to activate sequence';
      setError(message);
    }
  };

  const handleArchive = async () => {
    try {
      await api.post(`/sequences/${id}/archive`);
      setShowArchiveDialog(false);
      await loadSequence();
    } catch (err) {
      console.error('Failed to archive sequence:', err);
      setError('Failed to archive sequence');
    }
  };

  const handlePause = async () => {
    try {
      await api.post(`/sequences/${id}/pause`);
      await loadSequence();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to pause sequence';
      setError(message);
    }
  };

  const handleResume = async () => {
    try {
      await api.post(`/sequences/${id}/resume`);
      await loadSequence();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to resume sequence';
      setError(message);
    }
  };

  const handleAddStep = async () => {
    try {
      const position = steps.length + 1;
      const newStep = await api.post<SequenceStep>(`/sequences/${id}/steps`, {
        position,
        default_delay_hours: position === 1 ? 0 : 24,
        subject: '',
      });
      setSteps((prev) => [...prev, newStep]);
      setSelectedStepId(newStep.id);
    } catch (err) {
      console.error('Failed to add step:', err);
      setError('Failed to add step');
    }
  };

  const handleUpdateStep = useCallback(async (stepId: string, updates: Partial<SequenceStep>) => {
    setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, ...updates } : s)));
    try {
      await api.patch(`/sequences/${id}/steps/${stepId}`, updates);
    } catch (err) {
      console.error('Failed to update step:', err);
      setError('Failed to update step');
      await loadSequence();
    }
  }, [id]);

  const handleReorderSteps = useCallback(async (fromIndex: number, toIndex: number) => {
    const newSteps = [...steps];
    const [movedStep] = newSteps.splice(fromIndex, 1);
    newSteps.splice(toIndex, 0, movedStep);
    const reorderedSteps = newSteps.map((step, index) => ({ ...step, position: index + 1 }));
    setSteps(reorderedSteps);
    try {
      await Promise.all(reorderedSteps.map((step) => api.patch(`/sequences/${id}/steps/${step.id}`, { position: step.position })));
    } catch (err) {
      console.error('Failed to reorder steps:', err);
      setError('Failed to reorder steps');
      await loadSequence();
    }
  }, [id, steps]);

  const handleDeleteStep = async (stepId: string) => {
    try {
      await api.delete(`/sequences/${id}/steps/${stepId}`);
      setSteps((prev) => {
        const filtered = prev.filter((s) => s.id !== stepId);
        return filtered.map((step, index) => ({ ...step, position: index + 1 }));
      });
      if (selectedStepId === stepId) {
        const remaining = steps.filter((s) => s.id !== stepId);
        setSelectedStepId(remaining.length > 0 ? remaining[0].id : null);
      }
    } catch (err) {
      console.error('Failed to delete step:', err);
      setError('Failed to delete step');
    }
  };

  const handlePauseEnrollment = async (enrollmentId: string) => {
    try { await api.post(`/sequences/enrollments/${enrollmentId}/pause`); await loadEnrollments(); } catch (err) { console.error('Failed to pause enrollment:', err); }
  };

  const handleResumeEnrollment = async (enrollmentId: string) => {
    try { await api.post(`/sequences/enrollments/${enrollmentId}/resume`); await loadEnrollments(); } catch (err) { console.error('Failed to resume enrollment:', err); }
  };

  const handleExitEnrollment = async (enrollmentId: string) => {
    try { await api.post(`/sequences/enrollments/${enrollmentId}/exit?reason=manual_exit`); await loadEnrollments(); } catch (err) { console.error('Failed to exit enrollment:', err); }
  };

  const loadEnrollmentExecutions = async (enrollmentId: string) => {
    try {
      const data = await api.get<StepExecution[]>(`/sequences/enrollments/${enrollmentId}/executions`);
      setEnrollmentExecutions(data);
    } catch (err) { console.error('Failed to load executions:', err); }
  };

  const openEnrollmentDetail = (enrollment: Enrollment) => {
    setSelectedEnrollment(enrollment);
    loadEnrollmentExecutions(enrollment.id);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'draft': return <Badge variant="outline">Draft</Badge>;
      case 'active': return <Badge variant="success">Active</Badge>;
      case 'archived': return <Badge variant="secondary">Archived</Badge>;
      case 'paused': return <Badge variant="warning">Paused</Badge>;
      case 'completed': return <Badge variant="secondary">Completed</Badge>;
      case 'converted': return <Badge variant="success">Converted</Badge>;
      case 'exited': return <Badge variant="destructive">Exited</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const canEdit = sequence?.status === 'draft';

  if (isLoading) {
    return (<div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>);
  }

  if (!sequence) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Sequence not found</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/sequences')}>Back to Sequences</Button>
      </div>
    );
  }

  const isEmbedded = layout?.isEmbedded ?? false;

  return (
    <div className="flex flex-col h-screen">
      <div className={cn("flex items-center justify-between border-b bg-white", isEmbedded ? "px-4 py-2" : "px-6 py-4")}>
        <div className="flex items-center gap-3">
          <MenuButton />
          <Button variant="ghost" size="sm" onClick={() => router.push('/sequences')}>
            <ArrowLeft className="w-4 h-4 mr-1" />{!isEmbedded && 'Back'}
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className={cn("font-bold text-gray-900", isEmbedded ? "text-lg" : "text-2xl")}>{sequence.name}</h1>
              {getStatusBadge(sequence.status)}
            </div>
            {!isEmbedded && (
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="outline">{sequence.target_type_id ? targetTypes.find((t) => t.id === sequence.target_type_id)?.name ?? 'Unknown type' : 'All targets'}</Badge>
                {sequence.is_default && <Badge variant="secondary">Default</Badge>}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            {sequence.status === 'draft' && enrollmentCounts.paused === 0 && (
              <Button size={isEmbedded ? "sm" : "default"} onClick={handleActivate}><Play className="w-4 h-4 mr-1" />Activate</Button>
            )}
            {sequence.status === 'draft' && enrollmentCounts.paused > 0 && (
              <>
                <Button size={isEmbedded ? "sm" : "default"} onClick={handleResume}><Play className="w-4 h-4 mr-1" />Resume</Button>
                <Button size={isEmbedded ? "sm" : "default"} variant="outline" onClick={() => setShowArchiveDialog(true)}><Archive className="w-4 h-4 mr-1" />Archive</Button>
              </>
            )}
            {sequence.status === 'active' && (
              <>
                <Button size={isEmbedded ? "sm" : "default"} variant="outline" onClick={handlePause}><Pause className="w-4 h-4 mr-1" />Pause</Button>
                <Button size={isEmbedded ? "sm" : "default"} variant="outline" onClick={() => setShowArchiveDialog(true)}><Archive className="w-4 h-4 mr-1" />Archive</Button>
              </>
            )}
          </div>
          {!canEdit && sequence.status === 'active' && <span className="text-xs text-muted-foreground">Pause to make changes</span>}
        </div>
      </div>

      {error && (<Alert variant="destructive" className="mx-6 mt-4"><AlertCircle className="h-4 w-4" /><AlertDescription>{error}</AlertDescription></Alert>)}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'builder' | 'enrollments')} className="flex-1 flex flex-col">
        <div className={cn("border-b bg-white", isEmbedded ? "px-4" : "px-6")}>
          <TabsList>
            <TabsTrigger value="builder">Builder</TabsTrigger>
            <TabsTrigger value="enrollments">
              Enrollments
              {enrollmentCounts.active > 0 && <Badge variant="secondary" className="ml-2">{enrollmentCounts.active}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>
        </div>

        {isEmbedded && activeTab === 'builder' && (
          <div className="border-b bg-gray-50 px-4 py-2">
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
              {steps.map((step) => (
                <StepThumbnail key={step.id} step={step} isSelected={step.id === selectedStepId} onClick={() => setSelectedStepId(step.id)} />
              ))}
              {canEdit && (
                <button onClick={handleAddStep} className="flex-shrink-0 w-20 h-[74px] rounded-lg border-2 border-dashed border-gray-300 hover:border-primary hover:bg-primary/5 transition-colors flex items-center justify-center">
                  <span className="text-2xl text-gray-400">+</span>
                </button>
              )}
            </div>
          </div>
        )}

        <TabsContent value="builder" className="flex-1 mt-0">
          <SequenceEmailBuilder steps={steps} selectedStepId={selectedStepId} onSelectStep={setSelectedStepId} onAddStep={handleAddStep} onUpdateStep={handleUpdateStep} onDeleteStep={handleDeleteStep} onReorderSteps={handleReorderSteps} canEdit={canEdit} hideSidebar={isEmbedded} />
        </TabsContent>

        <TabsContent value="enrollments" className="flex-1 p-6 space-y-6 mt-0">
          <div className="grid grid-cols-5 gap-4">
            {(['active', 'paused', 'completed', 'converted', 'exited'] as const).map((status) => {
              const icons = { active: Play, paused: Pause, completed: Check, converted: Check, exited: LogOut };
              const colors = { active: 'text-green-600', paused: 'text-yellow-600', completed: 'text-blue-600', converted: 'text-green-600', exited: 'text-red-600' };
              const Icon = icons[status];
              return (
                <Card key={status} className={cn('cursor-pointer transition-colors', enrollmentFilter === status && 'ring-2 ring-primary')} onClick={() => setEnrollmentFilter(status)}>
                  <CardContent className="pt-4">
                    <div className="flex items-center gap-2"><Icon className={cn('w-4 h-4', colors[status])} /><span className="text-sm text-gray-600 capitalize">{status}</span></div>
                    <p className="text-2xl font-bold mt-1">{enrollmentCounts[status]}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card>
            <CardContent className="p-6">
              {enrollments.length === 0 ? (
                <div className="text-center py-8">
                  <Users className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No enrollments</h3>
                  <p className="text-gray-600">{enrollmentFilter === 'all' ? 'No targets have been enrolled in this sequence yet.' : `No ${enrollmentFilter} enrollments.`}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {enrollments.map((enrollment) => (
                    <div key={enrollment.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50">
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <span className="font-medium">{enrollment.target_email}</span>
                          {getStatusBadge(enrollment.status)}
                        </div>
                        <div className="flex items-center gap-4 mt-2 text-sm text-gray-600">
                          <span>Step {enrollment.current_step_position} of {enrollment.total_steps || steps.length}</span>
                          {enrollment.next_evaluation_at && <span>Next: {formatDate(enrollment.next_evaluation_at)}</span>}
                        </div>
                        <div className="flex items-center gap-3 mt-2">
                          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden max-w-xs">
                            <div className="h-full bg-green-500 rounded-full" style={{ width: `${((enrollment.current_step_position - 1) / (enrollment.total_steps || steps.length)) * 100}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground">{enrollment.current_step_position - 1}/{enrollment.total_steps || steps.length}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={() => openEnrollmentDetail(enrollment)}><Eye className="w-4 h-4" /></Button>
                        {enrollment.status === 'active' && <Button variant="ghost" size="sm" onClick={() => handlePauseEnrollment(enrollment.id)}><Pause className="w-4 h-4" /></Button>}
                        {enrollment.status === 'paused' && <Button variant="ghost" size="sm" onClick={() => handleResumeEnrollment(enrollment.id)}><RotateCcw className="w-4 h-4" /></Button>}
                        {(enrollment.status === 'active' || enrollment.status === 'paused') && <Button variant="ghost" size="sm" onClick={() => handleExitEnrollment(enrollment.id)}><LogOut className="w-4 h-4 text-red-500" /></Button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="analytics" className="flex-1 p-6 mt-0">
          <div className="text-center py-12"><p className="text-gray-500">Analytics coming soon</p></div>
        </TabsContent>
      </Tabs>

      <Dialog open={showArchiveDialog} onOpenChange={setShowArchiveDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Archive Sequence?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            {enrollmentCounts.active > 0
              ? `This sequence has ${enrollmentCounts.active} active enrollment${enrollmentCounts.active > 1 ? 's' : ''}. They will continue to completion but no new enrollments will be allowed.`
              : 'This will prevent new enrollments. You can reactivate the sequence later.'}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowArchiveDialog(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleArchive}>Archive</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedEnrollment} onOpenChange={() => setSelectedEnrollment(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Enrollment Details</DialogTitle></DialogHeader>
          {selectedEnrollment && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><div className="text-gray-500">Target</div><div className="font-medium">{selectedEnrollment.target_email}</div></div>
                <div><div className="text-gray-500">Status</div><div>{getStatusBadge(selectedEnrollment.status)}</div></div>
                <div><div className="text-gray-500">Current Step</div><div className="font-medium">{selectedEnrollment.current_step_position} of {selectedEnrollment.total_steps || steps.length}</div></div>
                <div><div className="text-gray-500">Enrolled At</div><div>{formatDate(selectedEnrollment.enrolled_at)}</div></div>
                {selectedEnrollment.next_evaluation_at && <div><div className="text-gray-500">Next Evaluation</div><div>{formatDate(selectedEnrollment.next_evaluation_at)}</div></div>}
                {selectedEnrollment.completed_at && <div><div className="text-gray-500">Completed At</div><div>{formatDate(selectedEnrollment.completed_at)}</div></div>}
                {selectedEnrollment.exit_reason && <div className="col-span-2"><div className="text-gray-500">Exit Reason</div><div className="font-medium">{selectedEnrollment.exit_reason}</div></div>}
              </div>
              <div>
                <div className="text-sm font-medium text-gray-700 mb-2">Execution History</div>
                {enrollmentExecutions.length === 0 ? (
                  <p className="text-sm text-gray-500">No executions yet</p>
                ) : (
                  <ul className="space-y-2">
                    {enrollmentExecutions.map((exec) => (
                      <li key={exec.id} className="flex items-center gap-2 text-sm">
                        {exec.status === 'executed' ? <Check className="w-4 h-4 text-green-600" /> : <SkipForward className="w-4 h-4 text-gray-400" />}
                        <span>Step {exec.step_position}</span>
                        <span className="text-muted-foreground">{exec.status === 'executed' ? 'Sent' : 'Skipped'} on {formatDate(exec.executed_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  api,
  type Sequence,
  type SequenceStep,
  type Enrollment,
  type StepExecution,
  type EnrollmentStatus,
  type ContentTemplate,
} from '@/api/client';
import {
  ArrowLeft,
  Plus,
  Play,
  Archive,
  ChevronUp,
  ChevronDown,
  Trash2,
  Clock,
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

export function SequenceBuilder() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Core state
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [steps, setSteps] = useState<SequenceStep[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'builder' | 'enrollments'>('builder');

  // Step editing state
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [showAddStepDialog, setShowAddStepDialog] = useState(false);
  const [newStepDelay, setNewStepDelay] = useState(24);
  const [isAddingStep, setIsAddingStep] = useState(false);

  // Content picker state
  const [showContentPicker, setShowContentPicker] = useState(false);
  const [contentPickerStepId, setContentPickerStepId] = useState<string | null>(null);
  const [availableContent, setAvailableContent] = useState<ContentTemplate[]>([]);
  const [selectedContentId, setSelectedContentId] = useState<string>('');
  const [contentPriority, setContentPriority] = useState(1);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  // Enrollment state
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [enrollmentFilter, setEnrollmentFilter] = useState<EnrollmentStatus | 'all'>('all');
  const [enrollmentCounts, setEnrollmentCounts] = useState({
    active: 0,
    paused: 0,
    completed: 0,
    converted: 0,
    exited: 0,
  });
  const [selectedEnrollment, setSelectedEnrollment] = useState<Enrollment | null>(null);
  const [enrollmentExecutions, setEnrollmentExecutions] = useState<StepExecution[]>([]);

  // Confirmation dialogs
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showDeleteStepDialog, setShowDeleteStepDialog] = useState(false);
  const [stepToDelete, setStepToDelete] = useState<SequenceStep | null>(null);

  useEffect(() => {
    if (id) {
      loadSequence();
    }
  }, [id]);

  useEffect(() => {
    if (id && activeTab === 'enrollments') {
      loadEnrollments();
    }
  }, [id, activeTab, enrollmentFilter]);

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

  const loadEnrollments = async () => {
    try {
      const endpoint = enrollmentFilter === 'all'
        ? `/sequences/${id}/enrollments`
        : `/sequences/${id}/enrollments?status=${enrollmentFilter}`;
      const data = await api.get<{ items: Enrollment[] }>(endpoint);
      setEnrollments(data.items || []);

      // Calculate counts from all enrollments (separate call without filter)
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

  const loadAvailableContent = async () => {
    setIsLoadingContent(true);
    try {
      // Load all content (don't filter by target_type_id to give more options)
      const data = await api.get<{ items: ContentTemplate[] }>('/content');
      setAvailableContent(data.items || []);
    } catch (err) {
      console.error('Failed to load content:', err);
    } finally {
      setIsLoadingContent(false);
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

  const handleAddStep = async () => {
    try {
      setIsAddingStep(true);
      const position = steps.length + 1;
      await api.post(`/sequences/${id}/steps`, {
        position,
        default_delay_hours: newStepDelay,
      });
      setShowAddStepDialog(false);
      setNewStepDelay(24);
      await loadSequence();
    } catch (err) {
      console.error('Failed to add step:', err);
      setError('Failed to add step');
    } finally {
      setIsAddingStep(false);
    }
  };

  const handleUpdateStepDelay = async (stepId: string, delayHours: number) => {
    // Optimistically update local state
    setSteps((prev) =>
      prev.map((s) => (s.id === stepId ? { ...s, default_delay_hours: delayHours } : s))
    );

    try {
      await api.patch(`/sequences/${id}/steps/${stepId}`, {
        default_delay_hours: delayHours,
      });
    } catch (err) {
      console.error('Failed to update step:', err);
      setError('Failed to update step');
      // Revert on error
      await loadSequence();
    }
  };

  const handleMoveStep = async (stepId: string, direction: 'up' | 'down') => {
    const stepIndex = steps.findIndex((s) => s.id === stepId);
    if (stepIndex === -1) return;

    const newIndex = direction === 'up' ? stepIndex - 1 : stepIndex + 1;
    if (newIndex < 0 || newIndex >= steps.length) return;

    try {
      // Swap positions
      const currentStep = steps[stepIndex];
      const otherStep = steps[newIndex];

      await api.patch(`/sequences/${id}/steps/${currentStep.id}`, {
        position: otherStep.position,
      });
      await api.patch(`/sequences/${id}/steps/${otherStep.id}`, {
        position: currentStep.position,
      });

      await loadSequence();
    } catch (err) {
      console.error('Failed to reorder steps:', err);
      setError('Failed to reorder steps');
    }
  };

  const handleDeleteStep = async () => {
    if (!stepToDelete) return;

    try {
      await api.delete(`/sequences/${id}/steps/${stepToDelete.id}`);
      setShowDeleteStepDialog(false);
      setStepToDelete(null);
      await loadSequence();
    } catch (err) {
      console.error('Failed to delete step:', err);
      setError('Failed to delete step');
    }
  };

  const openContentPicker = (stepId: string) => {
    setContentPickerStepId(stepId);
    setSelectedContentId('');
    setContentPriority(1);
    loadAvailableContent();
    setShowContentPicker(true);
  };

  const handleAddContent = async () => {
    if (!contentPickerStepId || !selectedContentId) return;

    try {
      await api.post(`/sequences/${id}/steps/${contentPickerStepId}/content`, {
        content_id: selectedContentId,
        priority: contentPriority,
      });
      setShowContentPicker(false);
      await loadSequence();
    } catch (err) {
      console.error('Failed to add content:', err);
      setError('Failed to add content');
    }
  };

  const handleRemoveContent = async (stepId: string, contentId: string) => {
    try {
      await api.delete(`/sequences/${id}/steps/${stepId}/content/${contentId}`);
      await loadSequence();
    } catch (err) {
      console.error('Failed to remove content:', err);
      setError('Failed to remove content');
    }
  };

  const handlePauseEnrollment = async (enrollmentId: string) => {
    try {
      await api.post(`/sequences/enrollments/${enrollmentId}/pause`);
      await loadEnrollments();
    } catch (err) {
      console.error('Failed to pause enrollment:', err);
    }
  };

  const handleResumeEnrollment = async (enrollmentId: string) => {
    try {
      await api.post(`/sequences/enrollments/${enrollmentId}/resume`);
      await loadEnrollments();
    } catch (err) {
      console.error('Failed to resume enrollment:', err);
    }
  };

  const handleExitEnrollment = async (enrollmentId: string) => {
    try {
      await api.post(`/sequences/enrollments/${enrollmentId}/exit?reason=manual_exit`);
      await loadEnrollments();
    } catch (err) {
      console.error('Failed to exit enrollment:', err);
    }
  };

  const loadEnrollmentExecutions = async (enrollmentId: string) => {
    try {
      const data = await api.get<StepExecution[]>(
        `/sequences/enrollments/${enrollmentId}/executions`
      );
      setEnrollmentExecutions(data);
    } catch (err) {
      console.error('Failed to load executions:', err);
    }
  };

  const openEnrollmentDetail = (enrollment: Enrollment) => {
    setSelectedEnrollment(enrollment);
    loadEnrollmentExecutions(enrollment.id);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'draft':
        return <Badge variant="outline">Draft</Badge>;
      case 'active':
        return <Badge variant="success">Active</Badge>;
      case 'archived':
        return <Badge variant="secondary">Archived</Badge>;
      case 'paused':
        return <Badge variant="warning">Paused</Badge>;
      case 'completed':
        return <Badge variant="secondary">Completed</Badge>;
      case 'converted':
        return <Badge variant="success">Converted</Badge>;
      case 'exited':
        return <Badge variant="destructive">Exited</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const formatDelay = (hours: number) => {
    if (hours === 0) return 'Immediately';
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} delay`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    if (remainingHours === 0) return `${days} day${days > 1 ? 's' : ''} delay`;
    return `${days} day${days > 1 ? 's' : ''} ${remainingHours}h delay`;
  };

  const canEdit = sequence?.status === 'draft';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!sequence) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Sequence not found</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/sequences')}>
          Back to Sequences
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate('/sequences')}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{sequence.name}</h1>
              {getStatusBadge(sequence.status)}
            </div>
            <p className="text-gray-600">{steps.length} steps</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sequence.status === 'draft' && (
            <Button onClick={handleActivate}>
              <Play className="w-4 h-4 mr-2" />
              Activate
            </Button>
          )}
          {sequence.status === 'active' && (
            <Button variant="outline" onClick={() => setShowArchiveDialog(true)}>
              <Archive className="w-4 h-4 mr-2" />
              Archive
            </Button>
          )}
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'builder' | 'enrollments')}>
        <TabsList>
          <TabsTrigger value="builder">Builder</TabsTrigger>
          <TabsTrigger value="enrollments">
            Enrollments
            {enrollmentCounts.active > 0 && (
              <Badge variant="secondary" className="ml-2">
                {enrollmentCounts.active}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Builder Tab */}
        <TabsContent value="builder" className="space-y-6">
          {!canEdit && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                This sequence is {sequence.status}. You cannot edit steps.
              </AlertDescription>
            </Alert>
          )}

          {/* Steps Timeline */}
          <Card>
            <CardContent className="p-6">
              {steps.length === 0 ? (
                <div className="text-center py-8">
                  <Clock className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No steps yet</h3>
                  <p className="text-gray-600 mb-4">Add your first step to start building the sequence</p>
                  {canEdit && (
                    <Button onClick={() => setShowAddStepDialog(true)}>
                      <Plus className="w-4 h-4 mr-2" />
                      Add First Step
                    </Button>
                  )}
                </div>
              ) : (
                <div className="relative pl-8">
                  {/* Vertical connector line */}
                  <div className="absolute left-3 top-3 bottom-3 w-0.5 bg-gray-200" />

                  {steps.map((step, index) => (
                    <div key={step.id} className="relative pb-8 last:pb-0">
                      {/* Step node */}
                      <div
                        className={cn(
                          'absolute left-0 w-6 h-6 rounded-full border-2 flex items-center justify-center',
                          'transform -translate-x-1/2 bg-white text-xs font-medium',
                          expandedStepId === step.id
                            ? 'ring-4 ring-primary/20 border-primary text-primary'
                            : 'border-gray-300 text-gray-600'
                        )}
                      >
                        {index + 1}
                      </div>

                      {/* Step content */}
                      <div className="ml-8">
                        <Card
                          className={cn(
                            'cursor-pointer transition-all',
                            expandedStepId === step.id && 'ring-2 ring-primary/20'
                          )}
                          onClick={() =>
                            setExpandedStepId(expandedStepId === step.id ? null : step.id)
                          }
                        >
                          <CardContent className="p-4">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="font-medium">
                                  {step.contents && step.contents.length > 0
                                    ? step.contents.sort((a, b) => a.priority - b.priority)[0]?.content_subject || `Step ${step.position}`
                                    : `Step ${step.position}`}
                                </div>
                                <div className="text-sm text-gray-600">
                                  {formatDelay(step.default_delay_hours)}
                                </div>
                              </div>
                              {canEdit && (
                                <div className="flex items-center gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={index === 0}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleMoveStep(step.id, 'up');
                                    }}
                                  >
                                    <ChevronUp className="w-4 h-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={index === steps.length - 1}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleMoveStep(step.id, 'down');
                                    }}
                                  >
                                    <ChevronDown className="w-4 h-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setStepToDelete(step);
                                      setShowDeleteStepDialog(true);
                                    }}
                                  >
                                    <Trash2 className="w-4 h-4 text-red-500" />
                                  </Button>
                                </div>
                              )}
                            </div>

                            {/* Expanded content */}
                            {expandedStepId === step.id && (
                              <div className="mt-4 pt-4 border-t space-y-4">
                                {/* Delay editor */}
                                {canEdit && (
                                  <div className="flex items-center gap-4">
                                    <Label>Delay (hours):</Label>
                                    <Input
                                      type="number"
                                      min="0"
                                      className="w-24"
                                      value={step.default_delay_hours}
                                      onChange={(e) =>
                                        handleUpdateStepDelay(step.id, parseInt(e.target.value) || 0)
                                      }
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                    {step.default_delay_hours === 0 && (
                                      <span className="text-sm text-muted-foreground">Immediately</span>
                                    )}
                                  </div>
                                )}

                                {/* Content list */}
                                <div>
                                  <div className="text-sm font-medium text-gray-700 mb-2">
                                    Content Options (priority order):
                                  </div>
                                  {step.contents && step.contents.length > 0 ? (
                                    <ul className="space-y-2">
                                      {step.contents
                                        .sort((a, b) => a.priority - b.priority)
                                        .map((content) => (
                                          <li
                                            key={content.id}
                                            className="flex items-center justify-between bg-gray-50 p-2 rounded"
                                          >
                                            <div className="flex items-center gap-2">
                                              <Badge variant="outline" className="text-xs">
                                                P{content.priority}
                                              </Badge>
                                              <span className="text-sm">
                                                {content.content_subject || content.content_name || 'Untitled'}
                                              </span>
                                            </div>
                                            {canEdit && (
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleRemoveContent(step.id, content.content_id);
                                                }}
                                              >
                                                <Trash2 className="w-3 h-3" />
                                              </Button>
                                            )}
                                          </li>
                                        ))}
                                    </ul>
                                  ) : (
                                    <p className="text-sm text-gray-500">No content assigned</p>
                                  )}
                                  {canEdit && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="mt-2"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openContentPicker(step.id);
                                      }}
                                    >
                                      <Plus className="w-3 h-3 mr-1" />
                                      Add Content
                                    </Button>
                                  )}
                                </div>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      </div>
                    </div>
                  ))}

                  {/* Add step button */}
                  {canEdit && steps.length > 0 && (
                    <div className="relative pt-4">
                      <div className="absolute left-0 w-6 h-6 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center transform -translate-x-1/2 bg-white">
                        <Plus className="w-3 h-3 text-gray-400" />
                      </div>
                      <div className="ml-8">
                        <Button
                          variant="outline"
                          onClick={() => setShowAddStepDialog(true)}
                        >
                          <Plus className="w-4 h-4 mr-2" />
                          Add Step
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Enrollments Tab */}
        <TabsContent value="enrollments" className="space-y-6">
          {/* Stats Cards */}
          <div className="grid grid-cols-5 gap-4">
            <Card
              className={cn(
                'cursor-pointer transition-colors',
                enrollmentFilter === 'active' && 'ring-2 ring-primary'
              )}
              onClick={() => setEnrollmentFilter('active')}
            >
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <Play className="w-4 h-4 text-green-600" />
                  <span className="text-sm text-gray-600">Active</span>
                </div>
                <p className="text-2xl font-bold mt-1">{enrollmentCounts.active}</p>
              </CardContent>
            </Card>
            <Card
              className={cn(
                'cursor-pointer transition-colors',
                enrollmentFilter === 'paused' && 'ring-2 ring-primary'
              )}
              onClick={() => setEnrollmentFilter('paused')}
            >
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <Pause className="w-4 h-4 text-yellow-600" />
                  <span className="text-sm text-gray-600">Paused</span>
                </div>
                <p className="text-2xl font-bold mt-1">{enrollmentCounts.paused}</p>
              </CardContent>
            </Card>
            <Card
              className={cn(
                'cursor-pointer transition-colors',
                enrollmentFilter === 'completed' && 'ring-2 ring-primary'
              )}
              onClick={() => setEnrollmentFilter('completed')}
            >
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-blue-600" />
                  <span className="text-sm text-gray-600">Completed</span>
                </div>
                <p className="text-2xl font-bold mt-1">{enrollmentCounts.completed}</p>
              </CardContent>
            </Card>
            <Card
              className={cn(
                'cursor-pointer transition-colors',
                enrollmentFilter === 'converted' && 'ring-2 ring-primary'
              )}
              onClick={() => setEnrollmentFilter('converted')}
            >
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-green-600" />
                  <span className="text-sm text-gray-600">Converted</span>
                </div>
                <p className="text-2xl font-bold mt-1">{enrollmentCounts.converted}</p>
              </CardContent>
            </Card>
            <Card
              className={cn(
                'cursor-pointer transition-colors',
                enrollmentFilter === 'exited' && 'ring-2 ring-primary'
              )}
              onClick={() => setEnrollmentFilter('exited')}
            >
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  <LogOut className="w-4 h-4 text-red-600" />
                  <span className="text-sm text-gray-600">Exited</span>
                </div>
                <p className="text-2xl font-bold mt-1">{enrollmentCounts.exited}</p>
              </CardContent>
            </Card>
          </div>

          {/* Enrollment List */}
          <Card>
            <CardContent className="p-6">
              {enrollments.length === 0 ? (
                <div className="text-center py-8">
                  <Users className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No enrollments</h3>
                  <p className="text-gray-600">
                    {enrollmentFilter === 'all'
                      ? 'No targets have been enrolled in this sequence yet.'
                      : `No ${enrollmentFilter} enrollments.`}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {enrollments.map((enrollment) => (
                    <div
                      key={enrollment.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <span className="font-medium">{enrollment.target_email}</span>
                          {getStatusBadge(enrollment.status)}
                        </div>
                        <div className="flex items-center gap-4 mt-2 text-sm text-gray-600">
                          <span>
                            Step {enrollment.current_step_position} of {enrollment.total_steps || steps.length}
                          </span>
                          {enrollment.next_evaluation_at && (
                            <span>Next: {formatDate(enrollment.next_evaluation_at)}</span>
                          )}
                        </div>
                        {/* Progress bar */}
                        <div className="flex items-center gap-3 mt-2">
                          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden max-w-xs">
                            <div
                              className="h-full bg-green-500 rounded-full"
                              style={{
                                width: `${
                                  ((enrollment.current_step_position - 1) /
                                    (enrollment.total_steps || steps.length)) *
                                  100
                                }%`,
                              }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {enrollment.current_step_position - 1}/{enrollment.total_steps || steps.length}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEnrollmentDetail(enrollment)}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        {enrollment.status === 'active' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handlePauseEnrollment(enrollment.id)}
                          >
                            <Pause className="w-4 h-4" />
                          </Button>
                        )}
                        {enrollment.status === 'paused' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleResumeEnrollment(enrollment.id)}
                          >
                            <RotateCcw className="w-4 h-4" />
                          </Button>
                        )}
                        {(enrollment.status === 'active' || enrollment.status === 'paused') && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleExitEnrollment(enrollment.id)}
                          >
                            <LogOut className="w-4 h-4 text-red-500" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Step Dialog */}
      <Dialog open={showAddStepDialog} onOpenChange={setShowAddStepDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Step</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="delay">Wait time (hours)</Label>
              <Input
                id="delay"
                type="number"
                min="0"
                value={newStepDelay}
                onChange={(e) => setNewStepDelay(parseInt(e.target.value) || 0)}
              />
              <p className="text-sm text-gray-500">
                {newStepDelay === 0 ? 'Send immediately after previous step' : 'How long to wait after the previous step before sending'}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddStepDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddStep} disabled={isAddingStep}>
              {isAddingStep ? 'Adding...' : 'Add Step'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Content Picker Dialog */}
      <Dialog open={showContentPicker} onOpenChange={setShowContentPicker}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Content to Step</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {isLoadingContent ? (
              <div className="flex items-center justify-center py-4">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
              </div>
            ) : availableContent.length === 0 ? (
              <div className="text-center py-4 text-muted-foreground">
                No content templates available. Create content first.
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>Content</Label>
                  <Select value={selectedContentId} onValueChange={setSelectedContentId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select content..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableContent.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.subject || c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Priority (lower = higher priority)</Label>
                  <Input
                    type="number"
                    min="1"
                    max="10"
                    value={contentPriority}
                    onChange={(e) => setContentPriority(parseInt(e.target.value) || 1)}
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowContentPicker(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddContent} disabled={!selectedContentId || isLoadingContent}>
              Add Content
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive Confirmation Dialog */}
      <Dialog open={showArchiveDialog} onOpenChange={setShowArchiveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive Sequence?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {enrollmentCounts.active > 0
              ? `This sequence has ${enrollmentCounts.active} active enrollment${enrollmentCounts.active > 1 ? 's' : ''}. They will continue to completion but no new enrollments will be allowed.`
              : 'This will prevent new enrollments. You can reactivate the sequence later.'}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowArchiveDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleArchive}>
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Step Confirmation Dialog */}
      <Dialog open={showDeleteStepDialog} onOpenChange={setShowDeleteStepDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Step?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete Step {stepToDelete?.position}? This will also remove all
            content assignments.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteStepDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteStep}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Enrollment Detail Dialog */}
      <Dialog open={!!selectedEnrollment} onOpenChange={() => setSelectedEnrollment(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Enrollment Details</DialogTitle>
          </DialogHeader>
          {selectedEnrollment && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-500">Target</div>
                  <div className="font-medium">{selectedEnrollment.target_email}</div>
                </div>
                <div>
                  <div className="text-gray-500">Status</div>
                  <div>{getStatusBadge(selectedEnrollment.status)}</div>
                </div>
                <div>
                  <div className="text-gray-500">Current Step</div>
                  <div className="font-medium">
                    {selectedEnrollment.current_step_position} of{' '}
                    {selectedEnrollment.total_steps || steps.length}
                  </div>
                </div>
                <div>
                  <div className="text-gray-500">Enrolled At</div>
                  <div>{formatDate(selectedEnrollment.enrolled_at)}</div>
                </div>
                {selectedEnrollment.next_evaluation_at && (
                  <div>
                    <div className="text-gray-500">Next Evaluation</div>
                    <div>{formatDate(selectedEnrollment.next_evaluation_at)}</div>
                  </div>
                )}
                {selectedEnrollment.completed_at && (
                  <div>
                    <div className="text-gray-500">Completed At</div>
                    <div>{formatDate(selectedEnrollment.completed_at)}</div>
                  </div>
                )}
                {selectedEnrollment.exit_reason && (
                  <div className="col-span-2">
                    <div className="text-gray-500">Exit Reason</div>
                    <div className="font-medium">{selectedEnrollment.exit_reason}</div>
                  </div>
                )}
              </div>

              {/* Execution History */}
              <div>
                <div className="text-sm font-medium text-gray-700 mb-2">Execution History</div>
                {enrollmentExecutions.length === 0 ? (
                  <p className="text-sm text-gray-500">No executions yet</p>
                ) : (
                  <ul className="space-y-2">
                    {enrollmentExecutions.map((exec) => (
                      <li key={exec.id} className="flex items-center gap-2 text-sm">
                        {exec.status === 'executed' ? (
                          <Check className="w-4 h-4 text-green-600" />
                        ) : (
                          <SkipForward className="w-4 h-4 text-gray-400" />
                        )}
                        <span>Step {exec.step_position}</span>
                        <span className="text-muted-foreground">
                          {exec.status === 'executed' ? 'Sent' : 'Skipped'} on{' '}
                          {formatDate(exec.executed_at)}
                        </span>
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

'use client';
import { useEffect, useState, useRef } from 'react';
import { FileText, Trash2, AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Upload, Undo2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { type SequenceStep, type BuilderContent, type DesignTemplate, listDesignTemplates } from '@/lib/api';

import { EmailListSidebar } from './EmailListSidebar';
import { EmailEditorCore } from '../email-builder/EmailEditorCore';
import {
  useDocument,
  useSelectedSidebarTab,
  resetDocument,
} from '../email-builder/documents/editor/EditorContext';
import { TEditorConfiguration } from '../email-builder/documents/editor/core';
import getConfiguration from '../email-builder/getConfiguration';

const formatDelay = (hours: number, isFirstEmail: boolean) => {
  const context = isFirstEmail ? 'after sign up' : 'after last email';
  if (hours === 0) return isFirstEmail ? 'Immediately after sign up' : 'Immediately after last email';
  const timeStr = hours < 24
    ? `${hours} hour${hours > 1 ? 's' : ''}`
    : `${Math.floor(hours / 24)} day${Math.floor(hours / 24) > 1 ? 's' : ''}`;
  return `${timeStr} ${context}`;
};

interface SequenceEmailBuilderProps {
  steps: SequenceStep[];
  selectedStepId: string | null;
  onSelectStep: (stepId: string) => void;
  onAddStep: () => void;
  onUpdateStep: (stepId: string, updates: Partial<SequenceStep>) => void;
  onDeleteStep?: (stepId: string) => void;
  onReorderSteps?: (fromIndex: number, toIndex: number) => void;
  canEdit?: boolean;
  hideSidebar?: boolean;
}

export function SequenceEmailBuilder({
  steps,
  selectedStepId,
  onSelectStep,
  onAddStep,
  onUpdateStep,
  onDeleteStep,
  onReorderSteps,
  canEdit = true,
  hideSidebar = false,
}: SequenceEmailBuilderProps) {
  const document = useDocument();
  const selectedSidebarTab = useSelectedSidebarTab();

  // Local draft state
  const [localSubject, setLocalSubject] = useState<string>('');
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  // Use ref for user interaction flag to avoid React state timing issues
  const userHasInteractedRef = useRef(false);
  const savedDocumentRef = useRef<TEditorConfiguration | null>(null);
  const savedSubjectRef = useRef<string>('');
  // Loading flag to completely ignore document changes during step transitions
  const isLoadingStepRef = useRef(false);

  // Templates state
  const [templates, setTemplates] = useState<DesignTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<DesignTemplate | null>(null);
  const [showTemplateConfirm, setShowTemplateConfirm] = useState(false);

  // Delete confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Delay state (convert hours to value + unit)
  const [delayValue, setDelayValue] = useState<number>(0);
  const [delayUnit, setDelayUnit] = useState<'days' | 'hours'>('days');

  const selectedStep = steps.find((s) => s.id === selectedStepId);

  // Transform steps to email list format
  const emails = steps.map((step) => ({
    id: step.id,
    subject: step.subject || `Email ${step.position}`,
    delay: formatDelay(step.default_delay_hours, step.position === 1),
    hasUnpublishedChanges: step.has_unpublished_changes,
    builderContent: step.builder_content,
  }));

  // Track the step ID to detect step changes
  const currentStepIdRef = useRef<string | null>(null);

  // Load document when selected step changes
  useEffect(() => {
    if (selectedStep) {
      // Set loading flag BEFORE any state changes - blocks all change detection
      isLoadingStepRef.current = true;
      userHasInteractedRef.current = false;
      savedDocumentRef.current = null;
      setHasLocalChanges(false);
      currentStepIdRef.current = selectedStepId;

      const content = selectedStep.builder_content
        ? selectedStep.builder_content as TEditorConfiguration
        : getConfiguration('#sample/empty-email-message');

      resetDocument(content);
      savedSubjectRef.current = selectedStep.subject || '';
      setLocalSubject(selectedStep.subject || '');

      // Convert hours to value + unit
      const hours = selectedStep.default_delay_hours;
      if (hours === 0) {
        setDelayValue(0);
        setDelayUnit('days');
      } else if (hours % 24 === 0) {
        setDelayValue(hours / 24);
        setDelayUnit('days');
      } else {
        setDelayValue(hours);
        setDelayUnit('hours');
      }

      // Clear loading flag after document has had time to stabilize
      // This prevents false positives from resetDocument's async updates
      const timeoutId = setTimeout(() => {
        isLoadingStepRef.current = false;
      }, 500);

      return () => clearTimeout(timeoutId);
    }
  }, [selectedStepId]);

  // Track document changes - only after loading completes and user has interacted
  useEffect(() => {
    // Completely ignore document changes during step loading
    if (isLoadingStepRef.current) {
      return;
    }
    // Only track if user has actually interacted
    if (!userHasInteractedRef.current || !savedDocumentRef.current) {
      return;
    }
    // Check if document differs from saved baseline
    const hasDocChanges = JSON.stringify(document) !== JSON.stringify(savedDocumentRef.current);
    const hasSubjectChanges = localSubject !== savedSubjectRef.current;
    setHasLocalChanges(hasDocChanges || hasSubjectChanges);
  }, [document, localSubject]);

  // Mark user as having interacted when they click in the editor
  const handleEditorInteraction = () => {
    // Don't register interaction during step loading
    if (isLoadingStepRef.current) {
      return;
    }
    if (!userHasInteractedRef.current && selectedStepId) {
      // Save current document as baseline when user first interacts
      savedDocumentRef.current = document as TEditorConfiguration;
      userHasInteractedRef.current = true;
    }
  };

  // Load templates when templates tab is selected
  useEffect(() => {
    if (selectedSidebarTab === 'templates' && templates.length === 0) {
      listDesignTemplates().then(setTemplates).catch(console.error);
    }
  }, [selectedSidebarTab, templates.length]);

  const handleSubjectChange = (subject: string) => {
    setLocalSubject(subject);
    // Don't register changes during step loading
    if (isLoadingStepRef.current) {
      return;
    }
    // Subject change counts as user interaction
    if (selectedStepId && !userHasInteractedRef.current) {
      savedDocumentRef.current = document as TEditorConfiguration;
      userHasInteractedRef.current = true;
    }
    // Check if subject differs from saved baseline
    if (savedSubjectRef.current !== subject) {
      setHasLocalChanges(true);
    }
  };

  const handleDelayValueChange = (value: number) => {
    setDelayValue(value);
    if (selectedStepId) {
      const hours = delayUnit === 'days' ? value * 24 : value;
      onUpdateStep(selectedStepId, { default_delay_hours: hours });
    }
  };

  const handleDelayUnitChange = (unit: 'days' | 'hours') => {
    setDelayUnit(unit);
    if (selectedStepId) {
      const hours = unit === 'days' ? delayValue * 24 : delayValue;
      onUpdateStep(selectedStepId, { default_delay_hours: hours });
    }
  };

  const handlePublish = async () => {
    if (!selectedStepId) return;

    setIsPublishing(true);
    try {
      await onUpdateStep(selectedStepId, {
        subject: localSubject,
        builder_content: document as BuilderContent,
        has_unpublished_changes: false,
      });
      savedDocumentRef.current = document as TEditorConfiguration;
      savedSubjectRef.current = localSubject;
      setHasLocalChanges(false);
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDiscard = () => {
    if (savedDocumentRef.current) {
      resetDocument(savedDocumentRef.current);
    }
    setLocalSubject(savedSubjectRef.current);
    setHasLocalChanges(false);
  };

  const handleTemplateClick = (template: DesignTemplate) => {
    setSelectedTemplate(template);
    setShowTemplateConfirm(true);
  };

  const handleApplyTemplate = () => {
    if (selectedTemplate?.builder_content) {
      resetDocument(selectedTemplate.builder_content as TEditorConfiguration);
      setHasLocalChanges(true);
    }
    setShowTemplateConfirm(false);
    setSelectedTemplate(null);
  };

  const handleDeleteStep = () => {
    if (selectedStepId && onDeleteStep) {
      onDeleteStep(selectedStepId);
      setShowDeleteConfirm(false);
    }
  };

  // Templates tab content for the sidebar
  const templatesTabContent = (
    <div className="p-4 space-y-2">
      {!canEdit && (
        <div className="p-2 mb-2 bg-muted rounded-md">
          <span className="text-muted-foreground text-xs">Pause sequence to apply templates</span>
        </div>
      )}
      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No templates available</p>
      ) : (
        templates.map((template) => (
          <button
            key={template.id}
            onClick={() => canEdit && handleTemplateClick(template)}
            disabled={!canEdit}
            className={`w-full p-3 text-left border rounded-lg transition-colors ${
              canEdit ? 'hover:bg-muted cursor-pointer' : 'opacity-50 cursor-not-allowed'
            }`}
          >
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <div className="min-w-0">
                <div className="font-medium text-sm text-foreground truncate">{template.name}</div>
                {template.description && (
                  <div className="text-xs text-muted-foreground truncate">{template.description}</div>
                )}
              </div>
            </div>
          </button>
        ))
      )}
    </div>
  );

  return (
    <div className={hideSidebar ? "flex flex-col h-full" : "flex h-[calc(100vh-120px)]"}>
      {/* Left Sidebar - Email List (hidden in embedded mode) */}
      {!hideSidebar && (
        <EmailListSidebar
          emails={emails}
          selectedEmailId={selectedStepId}
          onSelectEmail={onSelectStep}
          onAddEmail={onAddStep}
          onReorderEmails={onReorderSteps}
          canEdit={canEdit}
        />
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedStep ? (
          <>
            {/* Top Bar - Subject & Delay Controls */}
            <div className="border-b bg-background px-6 py-4 shrink-0 space-y-3">
              <div className="flex items-center gap-6">
                {/* Subject Line */}
                <div className="flex-1">
                  <Label htmlFor="subject" className="text-sm font-medium text-foreground mb-1.5 block">
                    Subject line
                  </Label>
                  <Input
                    id="subject"
                    value={localSubject}
                    onChange={(e) => handleSubjectChange(e.target.value)}
                    placeholder="Enter email subject..."
                    className="max-w-xl"
                    disabled={!canEdit}
                  />
                </div>

                {/* Delay Selector */}
                <div>
                  <Label className="text-sm font-medium text-foreground mb-1.5 block">
                    Send email
                  </Label>
                  {delayValue === 0 ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-foreground font-medium">Immediately</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelayValueChange(1)}
                        disabled={!canEdit}
                        className="text-xs text-muted-foreground h-7"
                      >
                        Add delay
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        value={delayValue}
                        onChange={(e) => handleDelayValueChange(parseInt(e.target.value) || 0)}
                        className="w-16 text-center"
                        disabled={!canEdit}
                      />
                      <Select
                        value={delayUnit}
                        onValueChange={(value) => handleDelayUnitChange(value as 'days' | 'hours')}
                        disabled={!canEdit}
                      >
                        <SelectTrigger className="w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="hours">hour(s)</SelectItem>
                          <SelectItem value="days">day(s)</SelectItem>
                        </SelectContent>
                      </Select>
                      <span className="text-sm text-muted-foreground">
                        {selectedStep.position === 1 ? 'after sign up' : 'after last email'}
                      </span>
                    </div>
                  )}
                </div>

                {/* Approval Required Toggle */}
                <div className="border-l pl-6">
                  <div className="flex items-center gap-3">
                    <div className="space-y-0.5">
                      <Label htmlFor="require-approval" className="text-sm font-medium text-foreground">
                        Require approval
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {selectedStep.approval_required
                          ? 'Emails queued for review'
                          : 'Emails send automatically'}
                      </p>
                    </div>
                    <Switch
                      id="require-approval"
                      checked={selectedStep.approval_required}
                      onCheckedChange={(checked) => onUpdateStep(selectedStep.id, { approval_required: checked })}
                      disabled={!canEdit}
                    />
                  </div>
                </div>

                {/* Delete Button */}
                {canEdit && onDeleteStep && (
                  <div className="flex items-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowDeleteConfirm(true)}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                )}

                {/* Publish/Discard Actions */}
                {canEdit && hasLocalChanges && (
                  <div className="flex items-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDiscard}
                      disabled={isPublishing}
                    >
                      <Undo2 className="w-4 h-4 mr-1.5" />
                      Discard
                    </Button>
                    <Button
                      size="sm"
                      onClick={handlePublish}
                      disabled={isPublishing}
                    >
                      <Upload className="w-4 h-4 mr-1.5" />
                      {isPublishing ? 'Publishing...' : 'Publish'}
                    </Button>
                  </div>
                )}
              </div>

              {/* Warning when auto-send is enabled */}
              {!selectedStep.approval_required && (
                <Alert className="bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800">
                  <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  <AlertDescription className="text-amber-800 dark:text-amber-200 text-sm">
                    Emails will send automatically without review. Make sure your content is ready.
                  </AlertDescription>
                </Alert>
              )}
            </div>

            {/* Shared Email Editor Core - wrapped to detect user interaction */}
            <div onMouseDown={handleEditorInteraction} onKeyDown={handleEditorInteraction}>
              <EmailEditorCore
                showCodeTabs={false}
                readOnly={!canEdit}
                extraSidebarTabs={[
                  {
                    id: 'templates',
                    label: 'Templates',
                    content: templatesTabContent,
                  },
                ]}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-muted">
            <div className="text-center text-muted-foreground">
              <p className="text-lg mb-2">No email selected</p>
              <p className="text-sm">Select an email from the list or add a new one</p>
            </div>
          </div>
        )}
      </div>

      {/* Template Confirmation Dialog */}
      <Dialog open={showTemplateConfirm} onOpenChange={setShowTemplateConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply Template</DialogTitle>
            <DialogDescription>
              This will replace your current email content with the template defaults. Any unsaved changes will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTemplateConfirm(false)}>
              Cancel
            </Button>
            <Button onClick={handleApplyTemplate}>
              Replace Content
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Email</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this email? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteStep}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

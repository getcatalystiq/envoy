import { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, MoreVertical, ArrowRight, GitBranch, RefreshCw, History, ChevronDown, ChevronRight, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  listGraduationRules,
  listGraduationEvents,
  listTargetTypes,
  createGraduationRule,
  updateGraduationRule,
  deleteGraduationRule,
  type GraduationRule,
  type GraduationEvent,
  type RuleCondition,
  type RuleOperator,
  type TargetType,
} from '@/api/client';

const OPERATORS: { value: RuleOperator; label: string }[] = [
  { value: 'eq', label: 'Equals' },
  { value: 'ne', label: 'Not equals' },
  { value: 'gt', label: 'Greater than' },
  { value: 'gte', label: 'Greater than or equal' },
  { value: 'lt', label: 'Less than' },
  { value: 'lte', label: 'Less than or equal' },
  { value: 'contains', label: 'Contains' },
  { value: 'exists', label: 'Exists' },
];

const TARGET_FIELDS = [
  'status',
  'lifecycle_stage',
  'email',
  'first_name',
  'last_name',
  'company',
  'phone',
  'title',
  'industry',
];

type FieldCategory = 'target' | 'metadata' | 'custom';

function parseFieldValue(field: string): { category: FieldCategory; subField: string } {
  if (field.startsWith('metadata.')) {
    return { category: 'metadata', subField: field.replace('metadata.', '') };
  }
  if (field.startsWith('custom_fields.')) {
    return { category: 'custom', subField: field.replace('custom_fields.', '') };
  }
  return { category: 'target', subField: field };
}

function buildFieldValue(category: FieldCategory, subField: string): string {
  switch (category) {
    case 'metadata':
      return subField ? `metadata.${subField}` : '';
    case 'custom':
      return subField ? `custom_fields.${subField}` : '';
    default:
      return subField;
  }
}

interface ConditionRowProps {
  condition: RuleCondition;
  index: number;
  onChange: (index: number, condition: RuleCondition) => void;
  onRemove: (index: number) => void;
}

function ConditionRow({ condition, index, onChange, onRemove }: ConditionRowProps) {
  const showValue = condition.operator !== 'exists';
  const parsed = parseFieldValue(condition.field);
  const [fieldCategory, setFieldCategory] = useState<FieldCategory>(parsed.category);
  const [subField, setSubField] = useState(parsed.subField);

  // Sync local state when condition.field changes externally
  useEffect(() => {
    const newParsed = parseFieldValue(condition.field);
    setFieldCategory(newParsed.category);
    setSubField(newParsed.subField);
  }, [condition.field]);

  const handleCategoryChange = (newCategory: FieldCategory) => {
    setFieldCategory(newCategory);
    // Reset subField when category changes
    setSubField('');
    onChange(index, { ...condition, field: '' });
  };

  const handleSubFieldChange = (newSubField: string) => {
    setSubField(newSubField);
    const newField = buildFieldValue(fieldCategory, newSubField);
    onChange(index, { ...condition, field: newField });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Category selector */}
      <Select
        value={fieldCategory}
        onValueChange={(value) => handleCategoryChange(value as FieldCategory)}
      >
        <SelectTrigger className="w-[130px]">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="target">Target Field</SelectItem>
          <SelectItem value="metadata">Metadata</SelectItem>
          <SelectItem value="custom">Custom Field</SelectItem>
        </SelectContent>
      </Select>

      {/* Field selector - dropdown for target fields, text input for metadata/custom */}
      {fieldCategory === 'target' ? (
        <Select value={subField} onValueChange={handleSubFieldChange}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Select field" />
          </SelectTrigger>
          <SelectContent>
            {TARGET_FIELDS.map((field) => (
              <SelectItem key={field} value={field}>
                {field}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          className="w-[140px]"
          placeholder={fieldCategory === 'metadata' ? 'e.g., payment_status' : 'e.g., my_field'}
          value={subField}
          onChange={(e) => handleSubFieldChange(e.target.value)}
        />
      )}

      <Select
        value={condition.operator}
        onValueChange={(value) =>
          onChange(index, { ...condition, operator: value as RuleOperator })
        }
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Operator" />
        </SelectTrigger>
        <SelectContent>
          {OPERATORS.map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showValue && (
        <Input
          className="flex-1 min-w-[100px]"
          placeholder="Value"
          value={String(condition.value ?? '')}
          onChange={(e) => {
            const val = e.target.value;
            // Try to parse as number if it looks like one
            const parsed = !isNaN(Number(val)) && val.trim() !== '' ? Number(val) : val;
            onChange(index, { ...condition, value: parsed });
          }}
        />
      )}

      <Button variant="ghost" size="icon" onClick={() => onRemove(index)}>
        <Trash2 className="h-4 w-4 text-muted-foreground" />
      </Button>
    </div>
  );
}

export function GraduationRulesTab() {
  const [rules, setRules] = useState<GraduationRule[]>([]);
  const [targetTypes, setTargetTypes] = useState<TargetType[]>([]);
  const [events, setEvents] = useState<GraduationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(true);

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSourceTypeId, setNewSourceTypeId] = useState<string>('');
  const [newDestTypeId, setNewDestTypeId] = useState<string>('');
  const [newConditions, setNewConditions] = useState<RuleCondition[]>([]);
  const [newEnabled, setNewEnabled] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<GraduationRule | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSourceTypeId, setEditSourceTypeId] = useState<string>('');
  const [editDestTypeId, setEditDestTypeId] = useState<string>('');
  const [editConditions, setEditConditions] = useState<RuleCondition[]>([]);
  const [editEnabled, setEditEnabled] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete dialog state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingRule, setDeletingRule] = useState<GraduationRule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [rulesData, typesData, eventsData] = await Promise.all([
        listGraduationRules(),
        listTargetTypes(),
        listGraduationEvents(50),
      ]);
      setRules(rulesData);
      setTargetTypes(typesData);
      setEvents(eventsData);
    } catch {
      setError('Failed to load graduation rules');
    } finally {
      setLoading(false);
    }
  }

  async function refreshEvents() {
    setEventsLoading(true);
    try {
      const eventsData = await listGraduationEvents(50);
      setEvents(eventsData);
    } catch {
      // Silent fail for refresh
    } finally {
      setEventsLoading(false);
    }
  }

  async function handleToggleEnabled(rule: GraduationRule) {
    try {
      await updateGraduationRule(rule.id, { enabled: !rule.enabled });
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r))
      );
    } catch {
      // Revert on error - could add toast notification here
    }
  }

  function validateForm(
    sourceTypeId: string,
    destTypeId: string,
    name: string
  ): string | null {
    if (!name.trim()) return 'Name is required';
    if (!sourceTypeId) return 'Source type is required';
    if (!destTypeId) return 'Destination type is required';
    if (sourceTypeId === destTypeId)
      return 'Source and destination types must be different';
    return null;
  }

  async function handleCreate() {
    const validationError = validateForm(newSourceTypeId, newDestTypeId, newName);
    if (validationError) {
      setCreateError(validationError);
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      await createGraduationRule({
        name: newName,
        description: newDescription || undefined,
        source_target_type_id: newSourceTypeId,
        destination_target_type_id: newDestTypeId,
        conditions: newConditions,
        enabled: newEnabled,
      });
      setCreateOpen(false);
      resetCreateForm();
      loadData();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create graduation rule';
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  }

  function resetCreateForm() {
    setNewName('');
    setNewDescription('');
    setNewSourceTypeId('');
    setNewDestTypeId('');
    setNewConditions([]);
    setNewEnabled(true);
    setCreateError(null);
  }

  function addNewCondition() {
    setNewConditions((prev) => [
      ...prev,
      { field: '', operator: 'eq', value: '' },
    ]);
  }

  function updateNewCondition(index: number, condition: RuleCondition) {
    setNewConditions((prev) =>
      prev.map((c, i) => (i === index ? condition : c))
    );
  }

  function removeNewCondition(index: number) {
    setNewConditions((prev) => prev.filter((_, i) => i !== index));
  }

  function openEdit(rule: GraduationRule) {
    setEditingRule(rule);
    setEditName(rule.name);
    setEditDescription(rule.description || '');
    setEditSourceTypeId(rule.source_target_type_id);
    setEditDestTypeId(rule.destination_target_type_id);
    setEditConditions([...rule.conditions]);
    setEditEnabled(rule.enabled);
    setEditError(null);
    setEditOpen(true);
  }

  async function handleUpdate() {
    if (!editingRule) return;

    const validationError = validateForm(editSourceTypeId, editDestTypeId, editName);
    if (validationError) {
      setEditError(validationError);
      return;
    }

    setUpdating(true);
    setEditError(null);
    try {
      await updateGraduationRule(editingRule.id, {
        name: editName,
        description: editDescription || undefined,
        source_target_type_id: editSourceTypeId,
        destination_target_type_id: editDestTypeId,
        conditions: editConditions,
        enabled: editEnabled,
      });
      setEditOpen(false);
      setEditingRule(null);
      loadData();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update graduation rule';
      setEditError(message);
    } finally {
      setUpdating(false);
    }
  }

  function addEditCondition() {
    setEditConditions((prev) => [
      ...prev,
      { field: '', operator: 'eq', value: '' },
    ]);
  }

  function updateEditCondition(index: number, condition: RuleCondition) {
    setEditConditions((prev) =>
      prev.map((c, i) => (i === index ? condition : c))
    );
  }

  function removeEditCondition(index: number) {
    setEditConditions((prev) => prev.filter((_, i) => i !== index));
  }

  function openDelete(rule: GraduationRule) {
    setDeletingRule(rule);
    setDeleteError(null);
    setDeleteOpen(true);
  }

  async function handleDelete() {
    if (!deletingRule) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteGraduationRule(deletingRule.id);
      setDeleteOpen(false);
      setDeletingRule(null);
      loadData();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to delete graduation rule';
      setDeleteError(message);
    } finally {
      setDeleting(false);
    }
  }

  function formatRelativeTime(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (error) {
    return <div className="text-center py-12 text-destructive">{error}</div>;
  }

  // Show different empty state if no target types exist
  if (targetTypes.length < 2) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <GitBranch className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            Need More Target Types
          </h3>
          <p className="text-gray-600 mb-4">
            Graduation rules require at least two target types to define transitions.
            <br />
            Go to the Target Types tab to create more.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Graduation Rules</h2>
          <p className="text-sm text-muted-foreground">
            Define automatic transitions between target types based on conditions
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <GitBranch className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              No graduation rules yet
            </h3>
            <p className="text-gray-600 mb-4">
              Create rules to automatically transition targets between types
            </p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Rule
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                  Name
                </th>
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                  Flow
                </th>
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                  Conditions
                </th>
                <th className="h-10 px-4 text-left font-medium text-muted-foreground">
                  Status
                </th>
                <th className="h-10 px-4 text-right font-medium text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b last:border-0">
                  <td className="h-12 px-4">
                    <div>
                      <p className="font-medium">{rule.name}</p>
                      {rule.description && (
                        <p className="text-sm text-muted-foreground truncate max-w-xs">
                          {rule.description}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="h-12 px-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{rule.source_type_name}</Badge>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      <Badge variant="secondary">{rule.destination_type_name}</Badge>
                    </div>
                  </td>
                  <td className="h-12 px-4 text-muted-foreground">
                    {rule.conditions.length} condition
                    {rule.conditions.length !== 1 ? 's' : ''}
                  </td>
                  <td className="h-12 px-4">
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={() => handleToggleEnabled(rule)}
                    />
                  </td>
                  <td className="h-12 px-4 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(rule)}>
                          <Edit className="h-4 w-4 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => openDelete(rule)}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent Graduations Section */}
      <Card className="mt-6">
        <div
          className="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
          onClick={() => setHistoryExpanded(!historyExpanded)}
        >
          <div className="flex items-center gap-2">
            {historyExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <History className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium">Recent Graduations</h3>
            <span className="text-sm text-muted-foreground">({events.length})</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              refreshEvents();
            }}
            disabled={eventsLoading}
          >
            <RefreshCw className={`h-4 w-4 ${eventsLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        {historyExpanded && (
          <CardContent className="pt-0">
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No graduation events yet
              </p>
            ) : (
              <div className="divide-y">
                {events.map((event) => (
                  <div key={event.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-medium text-sm">
                          {event.target_email || (
                            <span className="text-muted-foreground italic">Deleted target</span>
                          )}
                        </p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <div className="flex items-center gap-1">
                            <Badge variant="outline" className="text-xs">
                              {event.source_type_name}
                            </Badge>
                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            <Badge variant="secondary" className="text-xs">
                              {event.destination_type_name}
                            </Badge>
                          </div>
                          <span className="text-muted-foreground">·</span>
                          {event.manual ? (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <User className="h-3 w-3" />
                              Manual{event.triggered_by_email && (
                                <span className="truncate max-w-[150px]">
                                  ({event.triggered_by_email})
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              via "{event.rule_name || 'Deleted rule'}"
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                        {formatRelativeTime(event.created_at)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Graduation Rule</DialogTitle>
            <DialogDescription>
              Define when targets should automatically transition between types
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="new-name">Name *</Label>
              <Input
                id="new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Lead to Customer"
              />
            </div>
            <div>
              <Label htmlFor="new-description">Description</Label>
              <Textarea
                id="new-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Describe when this rule should apply..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Source Type *</Label>
                <Select value={newSourceTypeId} onValueChange={setNewSourceTypeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {targetTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Destination Type *</Label>
                <Select value={newDestTypeId} onValueChange={setNewDestTypeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select destination" />
                  </SelectTrigger>
                  <SelectContent>
                    {targetTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Conditions</Label>
                <Button variant="outline" size="sm" onClick={addNewCondition}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Condition
                </Button>
              </div>
              {newConditions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No conditions added. Rule will always match.
                </p>
              ) : (
                <div className="space-y-2">
                  {newConditions.map((condition, index) => (
                    <ConditionRow
                      key={index}
                      condition={condition}
                      index={index}
                      onChange={updateNewCondition}
                      onRemove={removeNewCondition}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="new-enabled"
                checked={newEnabled}
                onCheckedChange={(checked) => setNewEnabled(checked === true)}
              />
              <Label htmlFor="new-enabled">Enable rule immediately</Label>
            </div>
            {createError && (
              <p className="text-sm text-destructive">{createError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Graduation Rule</DialogTitle>
            <DialogDescription>Update the graduation rule details</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-name">Name *</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="e.g., Lead to Customer"
              />
            </div>
            <div>
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Describe when this rule should apply..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Source Type *</Label>
                <Select value={editSourceTypeId} onValueChange={setEditSourceTypeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {targetTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Destination Type *</Label>
                <Select value={editDestTypeId} onValueChange={setEditDestTypeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select destination" />
                  </SelectTrigger>
                  <SelectContent>
                    {targetTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Conditions</Label>
                <Button variant="outline" size="sm" onClick={addEditCondition}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Condition
                </Button>
              </div>
              {editConditions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No conditions added. Rule will always match.
                </p>
              ) : (
                <div className="space-y-2">
                  {editConditions.map((condition, index) => (
                    <ConditionRow
                      key={index}
                      condition={condition}
                      index={index}
                      onChange={updateEditCondition}
                      onRemove={removeEditCondition}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="edit-enabled"
                checked={editEnabled}
                onCheckedChange={(checked) => setEditEnabled(checked === true)}
              />
              <Label htmlFor="edit-enabled">Enable rule</Label>
            </div>
            {editError && <p className="text-sm text-destructive">{editError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={updating}>
              {updating ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Graduation Rule</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deletingRule?.name}"?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This action cannot be undone. The rule will be permanently removed.
            </p>
            {deleteError && (
              <p className="text-sm text-destructive">{deleteError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

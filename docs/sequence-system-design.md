# Sequence System Design

> Design document for implementing sequences in Catalyst/Envoy - a system for orchestrating multi-step, adaptive customer journeys.

## Overview

Sequences are ongoing customer journeys that:
- Progress targets through steps over time
- Evaluate and adapt timing and content at each step
- Accumulate learnings to influence future decisions
- Support both rules-based and agentic decision-making

### Sequences vs. Campaigns

| Concept | Purpose | Lifecycle |
|---------|---------|-----------|
| **Sequence** | Ongoing nurture journeys (e.g., "New Lead Onboarding") | Continuous, targets progress through steps |
| **Campaign** | One-time communications (e.g., "Black Friday Promo") | Batch execution, scheduled/completed |

These are orthogonal—a target can be enrolled in a sequence AND receive campaign emails.

---

## Data Model

### Core Entities

```
┌─────────────────────────────────────────────────────────────────────┐
│                           SEQUENCE                                   │
│  (Template defining the journey for a target_type/segment combo)    │
├─────────────────────────────────────────────────────────────────────┤
│  - id (UUID)                                                        │
│  - org_id (FK)                                                      │
│  - name                                                             │
│  - target_type_id (FK, required)                                    │
│  - segment_id (FK, optional - for segment-specific sequences)       │
│  - is_default: boolean (one default per target_type/segment)        │
│  - status: draft | active | archived                                │
│  - created_at, updated_at                                           │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ has many
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        SEQUENCE_STEP                                 │
│  (Individual touchpoint in the sequence)                            │
├─────────────────────────────────────────────────────────────────────┤
│  - id (UUID)                                                        │
│  - sequence_id (FK)                                                 │
│  - position (int) - order in sequence                               │
│  - channel: email | linkedin | sms | etc.                           │
│  - default_delay_hours (int) - baseline timing from previous step   │
│  - content_selection_strategy: priority | performance | weighted    │
│  - evaluation_rules (JSONB) - rules for timing/content adaptation   │
│  - exit_conditions (JSONB) - when to skip/exit sequence             │
│  - created_at, updated_at                                           │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ has many (junction table)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SEQUENCE_STEP_CONTENT                            │
│  (Pool of content options for a step)                               │
├─────────────────────────────────────────────────────────────────────┤
│  - id (UUID)                                                        │
│  - step_id (FK → sequence_step)                                     │
│  - content_id (FK → content)                                        │
│  - priority (int) - for 'priority' selection strategy               │
│  - weight (float) - for weighted random selection                   │
│  - conditions (JSONB) - when to use this content                    │
│      e.g., {"min_lifecycle_stage": 3, "requires_previous_click": true}│
│  - created_at                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Progress Tracking

```
┌─────────────────────────────────────────────────────────────────────┐
│                     SEQUENCE_ENROLLMENT                              │
│  (A target's journey through a sequence)                            │
├─────────────────────────────────────────────────────────────────────┤
│  - id (UUID)                                                        │
│  - org_id (FK)                                                      │
│  - target_id (FK)                                                   │
│  - sequence_id (FK)                                                 │
│  - current_step_position (int) - where they are now                 │
│  - status: active | paused | completed | converted | exited         │
│  - enrolled_at                                                      │
│  - last_step_completed_at                                           │
│  - next_evaluation_at (timestamp) - when to evaluate next step      │
│  - learnings (JSONB) - accumulated insights about this target       │
│  - created_at, updated_at                                           │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ has many
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   SEQUENCE_STEP_EXECUTION                            │
│  (Immutable record of what happened at each step)                   │
├─────────────────────────────────────────────────────────────────────┤
│  - id (UUID)                                                        │
│  - enrollment_id (FK)                                               │
│  - step_position (int) - denormalized for history                   │
│  - scheduled_at (timestamp) - when we planned to execute            │
│  - executed_at (timestamp) - when we actually did                   │
│  - email_send_id (FK, nullable) - links to actual communication     │
│  - content_id (FK) - which content was selected                     │
│  - evaluation_snapshot (JSONB) - decisions made at this step        │
│  - status: scheduled | executed | skipped                           │
│  - created_at                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Entity Relationships

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│  target_type │──────<│   sequence   │>──────│   segment    │
└──────────────┘   1:N └──────────────┘ N:1   └──────────────┘
                              │
                              │ 1:N
                              ▼
                       ┌──────────────┐
                       │sequence_step │
                       └──────────────┘
                              │
                    ┌─────────┴─────────┐
                    │ 1:N               │ N:M
                    ▼                   ▼
           ┌────────────────┐   ┌───────────────────┐
           │sequence_step_  │   │sequence_step_     │
           │enrollment      │   │content            │
           └────────────────┘   └───────────────────┘
                    │                   │
                    │ 1:N               │ N:1
                    ▼                   ▼
           ┌────────────────┐   ┌───────────────────┐
           │sequence_step_  │   │     content       │
           │execution       │   │   (existing)      │
           └────────────────┘   └───────────────────┘
                    │
                    │ 1:1
                    ▼
           ┌────────────────┐
           │   email_send   │
           │   (existing)   │
           └────────────────┘
```

---

## Content Selection

### Selection Strategies

Each step defines a `content_selection_strategy`:

#### 1. Priority (default)
Pick highest priority content that matches conditions.

```python
def select_content_priority(step, target, learnings):
    candidates = step.content_pool.order_by('priority')
    for content in candidates:
        if matches_conditions(content.conditions, target, learnings):
            return content
    return candidates.first()  # fallback to highest priority
```

#### 2. Performance (learning-driven)
Pick content with best historical engagement for similar targets.

```python
def select_content_performance(step, target, learnings):
    candidates = step.content_pool

    scored = []
    for content in candidates:
        score = get_engagement_score(
            content_id=content.id,
            target_type=target.target_type_id,
            segment=target.segment_id,
            lifecycle_stage=target.lifecycle_stage
        )
        scored.append((content, score))

    return max(scored, key=lambda x: x[1])[0]
```

#### 3. Weighted (A/B testing)
Weighted random selection for experimentation.

```python
def select_content_weighted(step, target, learnings):
    candidates = step.content_pool
    weights = [c.weight for c in candidates]
    return random.choices(candidates, weights=weights)[0]
```

### Content Conditions

The `conditions` JSONB field on `sequence_step_content` can include:

```json
{
  "min_lifecycle_stage": 3,
  "max_lifecycle_stage": 5,
  "requires_previous_open": true,
  "requires_previous_click": false,
  "segment": "enterprise",
  "exclude_if_bounced": true
}
```

---

## Sequence Evaluation Loop

### Execution Cycle

```
┌──────────────────────────────────────────────────────────────────┐
│                    SEQUENCE EVALUATION CYCLE                      │
│              (Runs every N minutes via scheduler)                 │
└──────────────────────────────────────────────────────────────────┘

1. Find enrollments where next_evaluation_at <= NOW

2. For each enrollment:
   │
   ├─► Check exit conditions
   │   - Target converted? → status = 'converted', exit
   │   - Target unsubscribed? → status = 'exited', exit
   │   - Target bounced (permanent)? → status = 'exited', exit
   │   - Sequence completed? → status = 'completed', exit
   │
   ├─► Get current step from sequence
   │
   ├─► EVALUATE TIMING
   │   - Apply default_delay_hours as baseline
   │   - Check engagement history
   │   - Apply timing rules/agentic adjustment
   │   - Decide: send now, delay, or skip?
   │
   ├─► EVALUATE CONTENT
   │   - Get content pool for step
   │   - Filter by conditions
   │   - Apply selection strategy (priority/performance/weighted)
   │   - Optionally invoke agentic selection
   │
   ├─► EVALUATE CHANNEL (future)
   │   - Step defines preferred channel
   │   - Check channel availability for target
   │   - Optionally switch based on engagement patterns
   │
   ├─► Execute
   │   - Create email_send record
   │   - Invoke content personalization (agentic)
   │   - Queue for sending
   │
   └─► Update enrollment:
       - Increment current_step_position
       - Set next_evaluation_at
       - Update learnings
       - Create step_execution record
```

### Learnings Schema

The `learnings` JSONB field on `sequence_enrollment` accumulates insights:

```json
{
  "engagement_pattern": {
    "best_day_of_week": "tuesday",
    "best_time_of_day": "10:00",
    "avg_open_delay_hours": 4.5,
    "total_opens": 3,
    "total_clicks": 1
  },
  "content_preferences": {
    "highest_engagement_type": "case_study",
    "lowest_engagement_type": "promotional",
    "clicked_content_ids": ["uuid-1", "uuid-2"]
  },
  "timing_adjustments": {
    "total_delays": 2,
    "total_accelerations": 0,
    "last_adjustment_reason": "low engagement detected"
  },
  "flags": {
    "high_value": true,
    "unusual_pattern": false,
    "needs_attention": false
  },
  "lifecycle_velocity": "slow"
}
```

### Execution Snapshot Schema

The `evaluation_snapshot` JSONB field on `sequence_step_execution` records decisions:

```json
{
  "content_pool_size": 3,
  "selection_strategy": "priority",
  "content_selected_id": "uuid",
  "content_selected_reason": "matched condition: clicked_previous=true",
  "alternatives_considered": ["uuid-2", "uuid-3"],
  "timing": {
    "default_delay_hours": 72,
    "actual_delay_hours": 96,
    "adjustment_reason": "delayed +24h due to low recent engagement"
  },
  "channel": {
    "preferred": "email",
    "used": "email"
  },
  "agentic_evaluation": {
    "invoked": true,
    "model": "maven",
    "decision_factors": ["engagement_history", "lifecycle_stage"]
  }
}
```

---

## Rules vs. Agentic Decision Points

### Decision Matrix

| Decision Point | Rules | Agentic | Recommendation |
|----------------|-------|---------|----------------|
| Enrollment (which sequence?) | ✅ Default | Optional | Rules with optional AI override |
| Exit/Continue | ✅ | ✗ | Pure rules - deterministic |
| Timing | Baseline + constraints | Adjustments | Hybrid |
| Content Selection | Filter + priority | Final pick | Hybrid |
| Content Personalization | ✗ | ✅ | Pure agentic - AI's strength |
| Channel Selection | Constraints | Optimization | Hybrid |
| Lifecycle Assessment | ✗ | ✅ | Pure agentic (existing) |
| Sequence Switching | ✗ | ✅ | Pure agentic |

### Decision Flow Detail

#### 1. Enrollment Decision
**"Which sequence should this target enter?"**

- **Rules**: `target_type + segment → default sequence` (simple lookup)
- **Agentic** (optional): Analyze target's initial data to pick non-default sequence

#### 2. Exit/Continue Decision
**"Should this target continue in the sequence?"**

- **Rules only**: Converted? Unsubscribed? Bounced? → Exit
- Deterministic, fast, no ambiguity needed

#### 3. Timing Decision
**"When should we send the next step?"**

- **Rules layer**:
  - Default delay from step definition (baseline)
  - Hard constraints (min 24h between emails, no weekends, etc.)
  - Time-of-day preferences from learnings

- **Agentic layer**:
  - "Target hasn't engaged in 2 weeks - delay or push harder?"
  - "Target just opened 3 emails in a row - accelerate?"
  - Nuanced judgment calls

#### 4. Content Selection
**"Which content from the pool should we use?"**

- **Rules layer**:
  - Filter by conditions (lifecycle_stage, previous engagement)
  - Priority ordering as fallback
  - Performance scoring from historical data

- **Agentic layer**:
  - "Given everything we know, which content will resonate best?"
  - Consider factors rules can't easily encode

#### 5. Content Personalization
**"How should we adapt the content for this target?"**

- **Agentic only**: This is Maven's core strength
  - Take template content, personalize for target
  - Adjust tone, references, specific pain points

#### 6. Channel Selection (future)
**"Email, LinkedIn, SMS, or something else?"**

- **Rules layer**:
  - Step defines preferred channel
  - Fallback rules (no LinkedIn profile → use email)
  - Rate limits per channel

- **Agentic layer**:
  - "Target ignores emails but engages on LinkedIn"
  - Cross-channel optimization

#### 7. Lifecycle Stage Assessment
**"Has this target progressed?"**

- **Agentic only** (already implemented with Maven):
  - Analyze engagement patterns
  - Consider behavioral signals
  - Update lifecycle_stage on target

#### 8. Sequence Switching
**"Should we move this target to a different sequence?"**

- **Agentic only**:
  - "This target is way more engaged than expected"
  - "Move them to the accelerated sequence"
  - Complex trajectory analysis

### Hybrid Evaluation Pattern

```python
def evaluate_step(enrollment, step, target):
    # Fast path: Rules-based evaluation
    timing = apply_timing_rules(enrollment, step, target)
    content_candidates = filter_content_by_rules(step, target)

    # Check if we need agentic evaluation
    needs_agent = (
        len(content_candidates) > 1 or      # Multiple viable options
        enrollment.learnings.get('high_value') or  # Important target
        enrollment.learnings.get('unusual_pattern')  # Anomaly detected
    )

    if needs_agent:
        # Slow path: Agentic evaluation for complex decisions
        decision = maven_evaluate(
            target=target,
            timing_baseline=timing,
            content_options=content_candidates,
            engagement_history=get_history(target),
            learnings=enrollment.learnings
        )
        return decision
    else:
        # Fast path: Use rules-based selection
        return RulesDecision(
            timing=timing,
            content=content_candidates[0]  # Highest priority
        )
```

### Cost/Performance Trade-offs

```
                    RULES                           AGENTIC
                      │                                │
     ┌────────────────┴────────────────┐  ┌───────────┴───────────┐
     │ • Fast (milliseconds)           │  │ • Slower (seconds)    │
     │ • Free (no API costs)           │  │ • API costs per call  │
     │ • Predictable outcomes          │  │ • Variable outcomes   │
     │ • Easily auditable              │  │ • Needs explanation   │
     │ • Limited flexibility           │  │ • Highly adaptive     │
     └─────────────────────────────────┘  └───────────────────────┘
```

---

## Example: 5-Step Nurture Sequence

```
Sequence: "New End User Onboarding"
Target Type: End User
Segment: Film Production
Is Default: true

┌─────────────────────────────────────────────────────────────────┐
│ Step 1: Welcome                                                  │
│ Position: 1 | Delay: 0 hours | Channel: email                   │
│ Strategy: priority                                               │
├─────────────────────────────────────────────────────────────────┤
│ Content Pool:                                                    │
│   ├─ [P1] "Welcome to Catalyst - Getting Started" (educational) │
│   └─ [P2] "Welcome - Quick Start Guide" (educational, fallback) │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼ (3 days later)
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: Value Proposition                                        │
│ Position: 2 | Delay: 72 hours | Channel: email                  │
│ Strategy: performance                                            │
├─────────────────────────────────────────────────────────────────┤
│ Content Pool:                                                    │
│   ├─ "How Film Studios Save 40% on Equipment" (case_study)      │
│   ├─ "5 Ways to Streamline Your Production" (educational)       │
│   └─ "Customer Story: Award-Winning Director" (case_study)      │
│                                                                  │
│ → System picks based on what's worked for similar targets       │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼ (5 days later)
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: Objection Handling                                       │
│ Position: 3 | Delay: 120 hours | Channel: email                 │
│ Strategy: priority                                               │
├─────────────────────────────────────────────────────────────────┤
│ Content Pool:                                                    │
│   ├─ [P1, condition: clicked_previous] "Ready to dive deeper?"  │
│   ├─ [P1, condition: !opened_previous] "Did you miss this?"     │
│   └─ [P2] "Common questions answered" (fallback)                │
│                                                                  │
│ → Different content based on previous engagement                │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼ (7 days later)
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: Social Proof                                             │
│ Position: 4 | Delay: 168 hours | Channel: email                 │
│ Strategy: performance                                            │
├─────────────────────────────────────────────────────────────────┤
│ Content Pool:                                                    │
│   ├─ "Join 500+ Film Studios Using Catalyst" (promotional)      │
│   ├─ "What Our Customers Say" (case_study)                      │
│   └─ "Industry Recognition & Awards" (promotional)              │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼ (10 days later)
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: Call to Action                                           │
│ Position: 5 | Delay: 240 hours | Channel: email                 │
│ Strategy: priority                                               │
├─────────────────────────────────────────────────────────────────┤
│ Content Pool:                                                    │
│   ├─ [P1, condition: lifecycle_stage >= 3] "Schedule a Demo"    │
│   ├─ [P1, condition: lifecycle_stage < 3] "Free Trial Offer"    │
│   └─ [P2] "Let's Connect" (soft CTA fallback)                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Handling Sequence Changes

### The Problem
If sequences can evolve as we learn, how do we handle targets already in progress?

### Recommended Approach: Adaptive with Safeguards

1. **Sequence template evolves** - Add/remove/modify steps as you learn globally
2. **Enrollments reference current sequence** - Not a frozen snapshot
3. **At each evaluation**, consider current sequence structure
4. **Safeguards**:
   - Don't skip steps the target was about to receive
   - Don't repeat steps already executed
   - Track `step_position`, not `step_id` for progress

### Execution History Preservation

The `sequence_step_execution` table preserves what actually happened:
- Even if sequence changes, historical record shows actual decisions
- `step_position` is denormalized so history remains meaningful
- `evaluation_snapshot` captures the context at decision time

---

## Implementation Phases

### Phase 1: Foundation
- Implement core tables (sequences, steps, enrollments, executions)
- Implement content pool association (sequence_step_content)
- Rules-only evaluation (priority-based content selection)
- Basic scheduler for sequence evaluation

### Phase 2: Adaptive Timing
- Add timing adjustment rules
- Implement engagement-based timing modifications
- Add agentic timing evaluation for edge cases

### Phase 3: Intelligent Content Selection
- Implement performance-based content selection
- Add A/B testing via weighted selection
- Add agentic content selection for multi-option scenarios

### Phase 4: Cross-Sequence Intelligence
- Implement sequence switching logic
- Add agentic sequence recommendations
- Cross-target learning for content performance

### Phase 5: Multi-Channel (Future)
- Add channel selection logic
- Implement channel fallback rules
- Add cross-channel optimization

---

## Database Migration

```sql
-- sequences table
CREATE TABLE sequences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR(255) NOT NULL,
    target_type_id UUID NOT NULL REFERENCES target_types(id),
    segment_id UUID REFERENCES segments(id),
    is_default BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure only one default per target_type/segment combination
CREATE UNIQUE INDEX idx_sequences_default
    ON sequences (org_id, target_type_id, segment_id)
    WHERE is_default = true;

-- sequence_steps table
CREATE TABLE sequence_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    channel VARCHAR(50) NOT NULL DEFAULT 'email',
    default_delay_hours INTEGER NOT NULL DEFAULT 24,
    content_selection_strategy VARCHAR(20) NOT NULL DEFAULT 'priority'
        CHECK (content_selection_strategy IN ('priority', 'performance', 'weighted')),
    evaluation_rules JSONB DEFAULT '{}',
    exit_conditions JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (sequence_id, position)
);

-- sequence_step_content junction table
CREATE TABLE sequence_step_content (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    step_id UUID NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
    content_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL DEFAULT 1,
    weight FLOAT DEFAULT 1.0,
    conditions JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (step_id, content_id)
);

-- sequence_enrollments table
CREATE TABLE sequence_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    target_id UUID NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    sequence_id UUID NOT NULL REFERENCES sequences(id),
    current_step_position INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'converted', 'exited')),
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_step_completed_at TIMESTAMPTZ,
    next_evaluation_at TIMESTAMPTZ,
    learnings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for enrollment queries
CREATE INDEX idx_enrollments_next_eval
    ON sequence_enrollments (next_evaluation_at)
    WHERE status = 'active';
CREATE INDEX idx_enrollments_target
    ON sequence_enrollments (org_id, target_id);

-- sequence_step_executions table
CREATE TABLE sequence_step_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enrollment_id UUID NOT NULL REFERENCES sequence_enrollments(id) ON DELETE CASCADE,
    step_position INTEGER NOT NULL,
    scheduled_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    email_send_id UUID REFERENCES email_sends(id),
    content_id UUID REFERENCES content(id),
    evaluation_snapshot JSONB DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'executed', 'skipped')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS on all new tables
ALTER TABLE sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_step_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_step_executions ENABLE ROW LEVEL SECURITY;

-- RLS policies (following existing pattern)
CREATE POLICY sequences_isolation ON sequences
    USING (org_id = current_setting('app.current_org_id')::uuid);

CREATE POLICY sequence_enrollments_isolation ON sequence_enrollments
    USING (org_id = current_setting('app.current_org_id')::uuid);

-- Steps and executions inherit isolation through their parent tables
CREATE POLICY sequence_steps_isolation ON sequence_steps
    USING (sequence_id IN (
        SELECT id FROM sequences
        WHERE org_id = current_setting('app.current_org_id')::uuid
    ));

CREATE POLICY sequence_step_content_isolation ON sequence_step_content
    USING (step_id IN (
        SELECT ss.id FROM sequence_steps ss
        JOIN sequences s ON s.id = ss.sequence_id
        WHERE s.org_id = current_setting('app.current_org_id')::uuid
    ));

CREATE POLICY sequence_step_executions_isolation ON sequence_step_executions
    USING (enrollment_id IN (
        SELECT id FROM sequence_enrollments
        WHERE org_id = current_setting('app.current_org_id')::uuid
    ));
```

---

## Open Questions

1. **Enrollment triggers**: How does a target get enrolled? On creation? Manual? Via campaign?

2. **Multiple sequence enrollment**: Can a target be in multiple sequences simultaneously?

3. **Sequence priority**: If multiple sequences match (e.g., one for target_type, one for segment), which wins?

4. **Re-enrollment**: After completing/exiting a sequence, can a target re-enter?

5. **Pause/resume**: How do we handle paused enrollments when calculating timing?

6. **Cross-sequence learning**: Should learnings from one sequence influence another?

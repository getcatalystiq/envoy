import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { setDocument, useDocument, useSelectedBlockId } from '../../../documents/editor/EditorContext';
import { TEditorConfiguration } from '../../../documents/editor/core';

const SUPPORTED_BLOCKS = ['Text', 'Heading', 'Button', 'Html'] as const;
type SupportedBlockType = (typeof SUPPORTED_BLOCKS)[number];

interface PersonalizationConfig {
  enabled: boolean;
  prompt: string;
}

const DEFAULT_PERSONALIZATION: PersonalizationConfig = {
  enabled: false,
  prompt: '',
};

const MAX_PROMPT_LENGTH = 1000;
const DEBOUNCE_MS = 150;

function isSupportedBlockType(type: string | undefined): type is SupportedBlockType {
  return type !== undefined && SUPPORTED_BLOCKS.includes(type as SupportedBlockType);
}

export default function PersonalizationSection() {
  const selectedBlockId = useSelectedBlockId();
  const document = useDocument();

  // Track committed block ID to prevent stale updates
  const committedBlockIdRef = useRef<string | null>(null);
  const [localPrompt, setLocalPrompt] = useState('');
  const debouncedUpdateRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const block = selectedBlockId ? document[selectedBlockId] : null;
  const blockType = block?.type;
  const isSupported = isSupportedBlockType(blockType);

  const personalization = useMemo<PersonalizationConfig>(
    () => (block?.data?.personalization as PersonalizationConfig) ?? DEFAULT_PERSONALIZATION,
    [block?.data?.personalization]
  );

  // Sync local prompt when block changes
  useEffect(() => {
    if (selectedBlockId !== committedBlockIdRef.current) {
      if (debouncedUpdateRef.current) {
        clearTimeout(debouncedUpdateRef.current);
        debouncedUpdateRef.current = null;
      }
      committedBlockIdRef.current = selectedBlockId;
    }
    setLocalPrompt(personalization.prompt);
  }, [selectedBlockId, personalization.prompt]);

  const updatePersonalization = useCallback(
    (updates: Partial<PersonalizationConfig>) => {
      const targetBlockId = committedBlockIdRef.current;
      if (!targetBlockId) return;

      // Get fresh block data from document
      const targetBlock = document[targetBlockId];
      if (!targetBlock) return;

      const currentPersonalization =
        (targetBlock?.data?.personalization as PersonalizationConfig) ?? DEFAULT_PERSONALIZATION;

      const updatedBlock = {
        ...targetBlock,
        data: {
          ...targetBlock.data,
          personalization: { ...currentPersonalization, ...updates },
        },
      };

      setDocument({
        [targetBlockId]: updatedBlock,
      } as TEditorConfiguration);
    },
    [document]
  );

  const handlePromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setLocalPrompt(newValue);

      if (debouncedUpdateRef.current) {
        clearTimeout(debouncedUpdateRef.current);
      }

      debouncedUpdateRef.current = setTimeout(() => {
        updatePersonalization({ prompt: newValue });
      }, DEBOUNCE_MS);
    },
    [updatePersonalization]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debouncedUpdateRef.current) {
        clearTimeout(debouncedUpdateRef.current);
      }
    };
  }, []);

  if (!selectedBlockId || !isSupported) {
    return null;
  }

  const { enabled } = personalization;
  const showPromptError = enabled && !localPrompt.trim();

  return (
    <div className="border-t border-border pt-4 mt-4">
      <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium block mb-4">
        Personalization
      </span>

      <div className="flex items-center justify-between mb-4">
        <Label htmlFor="personalization-toggle">Enable AI Personalization</Label>
        <Switch
          id="personalization-toggle"
          checked={enabled}
          onCheckedChange={(checked) => updatePersonalization({ enabled: checked })}
        />
      </div>

      {enabled && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-200 space-y-2">
          <Label htmlFor="personalization-prompt">Personalization Prompt</Label>
          <Textarea
            id="personalization-prompt"
            value={localPrompt}
            onChange={handlePromptChange}
            placeholder="Describe how this content should be personalized for each recipient..."
            className="min-h-[140px] p-4"
            maxLength={MAX_PROMPT_LENGTH}
          />
          <div className="flex justify-between items-center">
            <p
              className={`text-xs transition-opacity ${showPromptError ? 'text-orange-500' : 'text-muted-foreground opacity-50'}`}
            >
              {showPromptError
                ? 'Please enter a personalization prompt'
                : `${localPrompt.length}/${MAX_PROMPT_LENGTH}`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

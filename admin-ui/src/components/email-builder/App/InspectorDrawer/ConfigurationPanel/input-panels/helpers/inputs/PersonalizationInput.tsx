import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { Sparkles } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  setDocument,
  useDocument,
  useSelectedBlockId,
} from '../../../../../../documents/editor/EditorContext';
import { TEditorConfiguration } from '../../../../../../documents/editor/core';

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

export default function PersonalizationInput() {
  const selectedBlockId = useSelectedBlockId();
  const document = useDocument();

  const committedBlockIdRef = useRef<string | null>(null);
  const [localPrompt, setLocalPrompt] = useState('');
  const debouncedUpdateRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const block = selectedBlockId ? document[selectedBlockId] : null;

  const personalization = useMemo<PersonalizationConfig>(
    () => (block?.data?.personalization as PersonalizationConfig) ?? DEFAULT_PERSONALIZATION,
    [block?.data?.personalization]
  );

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

  useEffect(() => {
    return () => {
      if (debouncedUpdateRef.current) {
        clearTimeout(debouncedUpdateRef.current);
      }
    };
  }, []);

  const { enabled } = personalization;

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <div className="flex items-center justify-between">
        <Label
          className={`text-xs flex items-center gap-1.5 ${
            enabled
              ? 'bg-gradient-to-r from-violet-500 via-purple-500 to-fuchsia-500 bg-[length:200%_100%] bg-clip-text text-transparent animate-ai-shimmer'
              : ''
          }`}
          htmlFor="personalization-toggle"
        >
          {enabled && <Sparkles className="h-3 w-3 text-purple-500 animate-sparkle" />}
          AI Personalization
        </Label>
        <Switch
          id="personalization-toggle"
          checked={enabled}
          onCheckedChange={(checked) => updatePersonalization({ enabled: checked })}
        />
      </div>

      {enabled && (
        <div className="flex flex-col gap-1.5 w-full mt-2">
          <Label className="text-xs" htmlFor="personalization-prompt">
            Prompt (optional)
          </Label>
          <Textarea
            id="personalization-prompt"
            value={localPrompt}
            onChange={handlePromptChange}
            placeholder="Describe how to personalize this content..."
            rows={3}
            maxLength={MAX_PROMPT_LENGTH}
          />
          <p className="text-xs text-muted-foreground">
            {localPrompt.length}/{MAX_PROMPT_LENGTH}
          </p>
        </div>
      )}
    </div>
  );
}

export interface SkillFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  lastModified?: string;
}

export interface Skill {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  prompt: string | null;
  enabled: boolean;
}

export interface SkillBuilderState {
  skillId: string | null;
  skillName: string;
  skillSlug: string;
  files: SkillFile[];
  selectedFile: string | null;
  openTabs: string[];
  fileContents: Record<string, string>;
  unsavedChanges: Set<string>;
  isFilesLoading: boolean;
  isSaving: boolean;
  isPublishing: boolean;
  draftStatus: 'draft' | 'published';
  publishError: string | null;
  reloadVersion: number;
}

export type SkillBuilderAction =
  | { type: 'SET_SKILL'; payload: { skillId: string; skillName: string; skillSlug: string } }
  | { type: 'SET_FILES'; payload: SkillFile[] }
  | { type: 'SET_FILES_LOADING'; payload: boolean }
  | { type: 'SELECT_FILE'; payload: string | null }
  | { type: 'OPEN_TAB'; payload: string }
  | { type: 'CLOSE_TAB'; payload: string }
  | { type: 'SET_FILE_CONTENT'; payload: { path: string; content: string } }
  | { type: 'MARK_UNSAVED'; payload: string }
  | { type: 'MARK_SAVED'; payload: string }
  | { type: 'SET_SAVING'; payload: boolean }
  | { type: 'SET_PUBLISHING'; payload: boolean }
  | { type: 'SET_DRAFT_STATUS'; payload: 'draft' | 'published' }
  | { type: 'SET_PUBLISH_ERROR'; payload: string | null }
  | { type: 'INCREMENT_RELOAD_VERSION' }
  | { type: 'RESET' };

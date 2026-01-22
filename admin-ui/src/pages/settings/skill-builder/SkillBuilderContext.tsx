import React, { createContext, useContext, useReducer, useCallback, ReactNode, useEffect } from 'react';
import { SkillBuilderState, SkillBuilderAction, SkillFile, Skill } from './types';
import { api } from '@/api/client';

const initialState: SkillBuilderState = {
  skillId: null,
  skillName: '',
  skillSlug: '',
  files: [],
  selectedFile: null,
  openTabs: [],
  fileContents: {},
  unsavedChanges: new Set(),
  isFilesLoading: false,
  isSaving: false,
  isPublishing: false,
  draftStatus: 'draft',
  publishError: null,
  reloadVersion: 0,
};

function reducer(state: SkillBuilderState, action: SkillBuilderAction): SkillBuilderState {
  switch (action.type) {
    case 'SET_SKILL':
      return {
        ...state,
        skillId: action.payload.skillId,
        skillName: action.payload.skillName,
        skillSlug: action.payload.skillSlug,
        files: [],
        selectedFile: null,
        openTabs: [],
        fileContents: {},
        unsavedChanges: new Set(),
      };

    case 'SET_FILES':
      return { ...state, files: action.payload, isFilesLoading: false };

    case 'SET_FILES_LOADING':
      return { ...state, isFilesLoading: action.payload };

    case 'SELECT_FILE':
      return { ...state, selectedFile: action.payload };

    case 'OPEN_TAB':
      if (state.openTabs.includes(action.payload)) {
        return { ...state, selectedFile: action.payload };
      }
      return {
        ...state,
        openTabs: [...state.openTabs, action.payload],
        selectedFile: action.payload,
      };

    case 'CLOSE_TAB': {
      const newTabs = state.openTabs.filter(t => t !== action.payload);
      const newSelected = state.selectedFile === action.payload
        ? newTabs[newTabs.length - 1] || null
        : state.selectedFile;
      const { [action.payload]: _, ...remainingContents } = state.fileContents;
      const newUnsaved = new Set(state.unsavedChanges);
      newUnsaved.delete(action.payload);
      return {
        ...state,
        openTabs: newTabs,
        selectedFile: newSelected,
        fileContents: remainingContents,
        unsavedChanges: newUnsaved,
      };
    }

    case 'SET_FILE_CONTENT':
      return {
        ...state,
        fileContents: {
          ...state.fileContents,
          [action.payload.path]: action.payload.content,
        },
      };

    case 'MARK_UNSAVED': {
      const newUnsaved = new Set(state.unsavedChanges);
      newUnsaved.add(action.payload);
      return { ...state, unsavedChanges: newUnsaved };
    }

    case 'MARK_SAVED': {
      const newUnsaved = new Set(state.unsavedChanges);
      newUnsaved.delete(action.payload);
      return { ...state, unsavedChanges: newUnsaved };
    }

    case 'SET_SAVING':
      return { ...state, isSaving: action.payload };

    case 'SET_PUBLISHING':
      return { ...state, isPublishing: action.payload };

    case 'SET_DRAFT_STATUS':
      return { ...state, draftStatus: action.payload };

    case 'SET_PUBLISH_ERROR':
      return { ...state, publishError: action.payload };

    case 'INCREMENT_RELOAD_VERSION':
      return { ...state, reloadVersion: state.reloadVersion + 1 };

    case 'RESET':
      return initialState;

    default:
      return state;
  }
}

interface SkillBuilderContextValue {
  state: SkillBuilderState;
  dispatch: React.Dispatch<SkillBuilderAction>;
  loadFiles: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  saveFile: (path: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  createFile: (path: string, type: 'file' | 'directory') => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  publishSkill: () => Promise<void>;
}

const SkillBuilderContext = createContext<SkillBuilderContextValue | null>(null);

export interface SkillBuilderProviderProps {
  children: ReactNode;
  skill: Skill;
}

export function SkillBuilderProvider({ children, skill }: SkillBuilderProviderProps) {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    skillId: skill.id,
    skillName: skill.name,
    skillSlug: skill.slug,
  });

  const loadFiles = useCallback(async () => {
    if (!state.skillId) return;

    dispatch({ type: 'SET_FILES_LOADING', payload: true });
    try {
      const params = new URLSearchParams({
        skill_slug: state.skillSlug,
        skill_name: state.skillName,
      });
      const response = await api.get<{ files: SkillFile[] }>(
        `/maven/skills/${state.skillId}/files?${params}`
      );
      dispatch({ type: 'SET_FILES', payload: response.files || [] });
    } catch (error) {
      console.error('Load files error:', error);
      dispatch({ type: 'SET_FILES_LOADING', payload: false });
    }
  }, [state.skillId, state.skillSlug, state.skillName]);

  const reloadFile = useCallback(async (path: string) => {
    if (!state.skillId) return;

    try {
      const response = await api.get<{ content: string }>(
        `/maven/skills/${state.skillId}/files/${encodeURIComponent(path)}`
      );
      dispatch({ type: 'SET_FILE_CONTENT', payload: { path, content: response.content } });
      dispatch({ type: 'INCREMENT_RELOAD_VERSION' });
    } catch (error) {
      console.error('Reload file error:', error);
    }
  }, [state.skillId]);

  const openFile = useCallback(async (path: string) => {
    if (!state.skillId) return;

    try {
      const response = await api.get<{ content: string }>(
        `/maven/skills/${state.skillId}/files/${encodeURIComponent(path)}`
      );
      dispatch({ type: 'SET_FILE_CONTENT', payload: { path, content: response.content } });
      dispatch({ type: 'OPEN_TAB', payload: path });
      dispatch({ type: 'INCREMENT_RELOAD_VERSION' });
    } catch (error) {
      console.error('Open file error:', error);
    }
  }, [state.skillId]);

  const saveFile = useCallback(async (path: string) => {
    if (!state.skillId || state.fileContents[path] === undefined) return;

    dispatch({ type: 'SET_SAVING', payload: true });
    try {
      await api.put(`/maven/skills/${state.skillId}/files/${encodeURIComponent(path)}`, {
        content: state.fileContents[path],
      });
      dispatch({ type: 'MARK_SAVED', payload: path });

      // Refresh files and reload current file content from server
      await loadFiles();
      await reloadFile(path);
    } catch (error) {
      console.error('Save file error:', error);
    } finally {
      dispatch({ type: 'SET_SAVING', payload: false });
    }
  }, [state.skillId, state.fileContents, loadFiles, reloadFile]);

  const saveAllFiles = useCallback(async () => {
    const unsavedPaths = Array.from(state.unsavedChanges);
    for (const path of unsavedPaths) {
      await saveFile(path);
    }
  }, [state.unsavedChanges, saveFile]);

  const createFile = useCallback(async (path: string, type: 'file' | 'directory') => {
    if (!state.skillId) return;

    try {
      await api.post(`/maven/skills/${state.skillId}/files`, {
        path,
        file_type: type,
      });

      await loadFiles();
      if (type === 'file') {
        await openFile(path);
      }
    } catch (error) {
      console.error('Create file error:', error);
      throw error;
    }
  }, [state.skillId, loadFiles, openFile]);

  const deleteFile = useCallback(async (path: string) => {
    if (!state.skillId) return;

    try {
      await api.delete(`/maven/skills/${state.skillId}/files/${encodeURIComponent(path)}`);

      // Close tab if open
      if (state.openTabs.includes(path)) {
        dispatch({ type: 'CLOSE_TAB', payload: path });
      }

      await loadFiles();
    } catch (error) {
      console.error('Delete file error:', error);
      throw error;
    }
  }, [state.skillId, state.openTabs, loadFiles]);

  const publishSkill = useCallback(async () => {
    if (!state.skillId || !state.skillSlug) return;

    dispatch({ type: 'SET_PUBLISH_ERROR', payload: null });
    dispatch({ type: 'SET_PUBLISHING', payload: true });
    try {
      // Save all unsaved files first
      await saveAllFiles();

      const response = await api.post<{ error?: string }>(
        `/maven/skills/${state.skillId}/publish`,
        { skill_slug: state.skillSlug }
      );

      if (response.error) {
        dispatch({ type: 'SET_PUBLISH_ERROR', payload: response.error });
        return;
      }

      dispatch({ type: 'SET_DRAFT_STATUS', payload: 'published' });
    } catch (error) {
      console.error('Publish error:', error);
      dispatch({ type: 'SET_PUBLISH_ERROR', payload: 'Failed to publish skill' });
    } finally {
      dispatch({ type: 'SET_PUBLISHING', payload: false });
    }
  }, [state.skillId, state.skillSlug, saveAllFiles]);

  // Load files on mount
  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const value: SkillBuilderContextValue = {
    state,
    dispatch,
    loadFiles,
    openFile,
    saveFile,
    saveAllFiles,
    createFile,
    deleteFile,
    publishSkill,
  };

  return (
    <SkillBuilderContext.Provider value={value}>
      {children}
    </SkillBuilderContext.Provider>
  );
}

export function useSkillBuilder() {
  const context = useContext(SkillBuilderContext);
  if (!context) {
    throw new Error('useSkillBuilder must be used within SkillBuilderProvider');
  }
  return context;
}

'use client';

import { useState, useMemo } from 'react';
import { useSkillBuilder } from './SkillBuilderContext';
import { SkillFile } from './types';
import { NewFileModal } from './NewFileModal';
import { Button } from '@/components/ui/button';
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  Plus,
  Trash2,
  Loader2,
  FileCode,
  FileText,
  Settings,
} from 'lucide-react';

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children: TreeNode[];
  file?: SkillFile;
}

function hasFileContent(node: TreeNode): boolean {
  if (node.type === 'file') {
    return true;
  }
  return node.children.some(child => hasFileContent(child));
}

function filterEmptyDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .filter(node => {
      if (node.type === 'file') return true;
      return hasFileContent(node);
    })
    .map(node => {
      if (node.type === 'directory') {
        return {
          ...node,
          children: filterEmptyDirs(node.children),
        };
      }
      return node;
    });
}

function buildFileTree(files: SkillFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  const pathMap = new Map<string, TreeNode>();

  const sortedFiles = [...files].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  for (const file of sortedFiles) {
    const parts = file.path.split('/');
    let currentPath = '';
    let parent: TreeNode[] = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      let node = pathMap.get(currentPath);
      if (!node) {
        node = {
          name: part,
          path: currentPath,
          type: isLast ? file.type : 'directory',
          children: [],
          file: isLast ? file : undefined,
        };
        pathMap.set(currentPath, node);
        parent.push(node);
      }

      parent = node.children;
    }
  }

  return filterEmptyDirs(root);
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'md':
      return <FileText className="w-4 h-4 text-blue-500" />;
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
    case 'sh':
      return <FileCode className="w-4 h-4 text-green-500" />;
    case 'json':
    case 'yaml':
    case 'yml':
      return <Settings className="w-4 h-4 text-yellow-600" />;
    default:
      return <File className="w-4 h-4 text-muted-foreground" />;
  }
}

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  expandedDirs: Set<string>;
  toggleDir: (path: string) => void;
  selectedPath: string | null;
  onSelect: (path: string, type: 'file' | 'directory') => void;
  onDelete: (path: string) => void;
  unsavedPaths: Set<string>;
}

function FileTreeNode({
  node,
  depth,
  expandedDirs,
  toggleDir,
  selectedPath,
  onSelect,
  onDelete,
  unsavedPaths,
}: FileTreeNodeProps) {
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedPath === node.path;
  const isUnsaved = unsavedPaths.has(node.path);

  const handleClick = () => {
    if (node.type === 'directory') {
      toggleDir(node.path);
    } else {
      onSelect(node.path, node.type);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete ${node.name}?`)) {
      onDelete(node.path);
    }
  };

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-muted group ${
          isSelected ? 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300' : ''
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
      >
        {node.type === 'directory' && (
          <span className="w-4 h-4 flex items-center justify-center text-muted-foreground">
            {isExpanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </span>
        )}
        {node.type === 'file' && <span className="w-4" />}

        {node.type === 'directory' ? (
          isExpanded ? (
            <FolderOpen className="w-4 h-4 text-yellow-500" />
          ) : (
            <Folder className="w-4 h-4 text-yellow-500" />
          )
        ) : (
          getFileIcon(node.name)
        )}

        <span className="flex-1 text-sm truncate">
          {node.name}
          {isUnsaved && <span className="text-yellow-600 ml-1">*</span>}
        </span>

        <button
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-red-500"
          onClick={handleDelete}
          title="Delete"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {node.type === 'directory' && isExpanded && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              toggleDir={toggleDir}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onDelete={onDelete}
              unsavedPaths={unsavedPaths}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SkillFileBrowser() {
  const { state, openFile, deleteFile, loadFiles } = useSkillBuilder();
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [showNewFileModal, setShowNewFileModal] = useState(false);

  const tree = useMemo(() => buildFileTree(state.files), [state.files]);

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleSelect = (path: string, type: 'file' | 'directory') => {
    if (type === 'file') {
      openFile(path);
    }
  };

  const handleDelete = async (path: string) => {
    await deleteFile(path);
  };

  return (
    <div className="flex flex-col h-full bg-background border-r min-w-[200px]">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-sm font-medium text-foreground">Files</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => loadFiles()}
            title="Refresh"
          >
            {state.isFilesLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setShowNewFileModal(true)}
            title="New File"
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {state.isFilesLoading && state.files.length === 0 ? (
          <div className="flex items-center justify-center p-4 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Loading...
          </div>
        ) : state.files.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-4 text-sm text-muted-foreground">
            <p>No files yet.</p>
            <p className="text-xs">Click + to create one.</p>
          </div>
        ) : (
          tree.map((node) => (
            <FileTreeNode
              key={node.path}
              node={node}
              depth={0}
              expandedDirs={expandedDirs}
              toggleDir={toggleDir}
              selectedPath={state.selectedFile}
              onSelect={handleSelect}
              onDelete={handleDelete}
              unsavedPaths={state.unsavedChanges}
            />
          ))
        )}
      </div>

      <NewFileModal
        isOpen={showNewFileModal}
        onClose={() => setShowNewFileModal(false)}
      />
    </div>
  );
}

import { useEffect, useCallback, useRef, useState } from 'react';
import { useSkillBuilder } from './SkillBuilderContext';
import { X, FileText } from 'lucide-react';

function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py':
      return 'python';
    case 'js':
      return 'javascript';
    case 'ts':
      return 'typescript';
    case 'jsx':
      return 'javascript';
    case 'tsx':
      return 'typescript';
    case 'md':
      return 'markdown';
    case 'json':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'sql':
      return 'sql';
    default:
      return 'plaintext';
  }
}

// Monaco editor HTML that runs in iframe
const MONACO_IFRAME_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: #1e1e1e; }
    #editor { height: 100%; width: 100%; }
  </style>
</head>
<body>
  <div id="editor"></div>
  <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
  <script>
    let editor = null;
    let currentLanguage = 'plaintext';
    let ignoreNextChange = false;

    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });

    require(['vs/editor/editor.main'], function () {
      editor = monaco.editor.create(document.getElementById('editor'), {
        value: '',
        language: 'plaintext',
        theme: 'vs-dark',
        minimap: { enabled: false },
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
        wordWrap: 'on',
        lineNumbers: 'on',
        tabSize: 2,
        insertSpaces: true,
        bracketPairColorization: { enabled: true },
        formatOnPaste: true,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 12 },
        renderWhitespace: 'selection',
        occurrencesHighlight: 'off',
      });

      // Listen for content changes
      editor.onDidChangeModelContent(() => {
        if (ignoreNextChange) {
          ignoreNextChange = false;
          return;
        }
        window.parent.postMessage({
          type: 'monaco-content-changed',
          content: editor.getValue()
        }, '*');
      });

      // Add Cmd/Ctrl+S keybinding
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        window.parent.postMessage({ type: 'monaco-save' }, '*');
      });

      // Notify parent that editor is ready
      window.parent.postMessage({ type: 'monaco-ready' }, '*');
    });

    // Listen for messages from parent
    window.addEventListener('message', (event) => {
      if (!editor) return;

      const { type, content, language } = event.data;

      if (type === 'set-content') {
        ignoreNextChange = true;
        editor.setValue(content || '');
      } else if (type === 'set-language') {
        const model = editor.getModel();
        if (model && language !== currentLanguage) {
          monaco.editor.setModelLanguage(model, language);
          currentLanguage = language;
        }
      } else if (type === 'focus') {
        editor.focus();
      }
    });
  </script>
</body>
</html>
`;

export function SkillCodeEditor() {
  const { state, dispatch, saveFile } = useSkillBuilder();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [isReady, setIsReady] = useState(false);
  const lastSentContent = useRef<string>('');
  const lastSentLanguage = useRef<string>('');
  const contentFromMonaco = useRef<boolean>(false);

  // Create blob URL for iframe
  const iframeSrc = useRef<string>(
    URL.createObjectURL(new Blob([MONACO_IFRAME_HTML], { type: 'text/html' }))
  );

  // Clean up blob URL on unmount
  useEffect(() => {
    const url = iframeSrc.current;
    return () => URL.revokeObjectURL(url);
  }, []);

  // Handle messages from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const { type, content } = event.data;

      if (type === 'monaco-ready') {
        setIsReady(true);
      } else if (type === 'monaco-content-changed' && state.selectedFile) {
        contentFromMonaco.current = true;
        dispatch({
          type: 'SET_FILE_CONTENT',
          payload: { path: state.selectedFile, content },
        });
        dispatch({ type: 'MARK_UNSAVED', payload: state.selectedFile });
      } else if (type === 'monaco-save' && state.selectedFile) {
        saveFile(state.selectedFile);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [state.selectedFile, dispatch, saveFile]);

  // Send content to iframe when file changes
  const currentContent = state.selectedFile
    ? state.fileContents[state.selectedFile] ?? ''
    : '';

  const currentLanguage = state.selectedFile
    ? getLanguageFromPath(state.selectedFile)
    : 'plaintext';

  const lastReloadVersion = useRef<number>(0);

  useEffect(() => {
    if (!isReady || !iframeRef.current?.contentWindow) return;

    const forceRefresh = state.reloadVersion > lastReloadVersion.current;
    if (forceRefresh) {
      lastReloadVersion.current = state.reloadVersion;
    }

    if (currentContent !== lastSentContent.current || forceRefresh) {
      if (contentFromMonaco.current && !forceRefresh) {
        contentFromMonaco.current = false;
        lastSentContent.current = currentContent;
      } else {
        iframeRef.current.contentWindow.postMessage(
          { type: 'set-content', content: currentContent },
          '*'
        );
        lastSentContent.current = currentContent;
        contentFromMonaco.current = false;
      }
    }

    if (currentLanguage !== lastSentLanguage.current) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'set-language', language: currentLanguage },
        '*'
      );
      lastSentLanguage.current = currentLanguage;
    }
  }, [isReady, currentContent, currentLanguage, state.reloadVersion]);

  const handleCloseTab = useCallback((path: string, e?: React.MouseEvent) => {
    e?.stopPropagation();

    if (state.unsavedChanges.has(path)) {
      if (!confirm('Discard unsaved changes?')) {
        return;
      }
    }
    dispatch({ type: 'CLOSE_TAB', payload: path });
  }, [state.unsavedChanges, dispatch]);

  const handleSelectTab = useCallback((path: string) => {
    dispatch({ type: 'SELECT_FILE', payload: path });
  }, [dispatch]);

  if (state.openTabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-gray-50 text-gray-400">
        <FileText className="w-16 h-16 mb-4 text-gray-300" />
        <p>Select a file to edit</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex items-center bg-gray-800 border-b border-gray-700 overflow-x-auto">
        {state.openTabs.map((path) => {
          const fileName = path.split('/').pop() || path;
          const isActive = path === state.selectedFile;
          const isUnsaved = state.unsavedChanges.has(path);

          return (
            <div
              key={path}
              className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer border-r border-gray-700 ${
                isActive
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
              onClick={() => handleSelectTab(path)}
            >
              <span className="whitespace-nowrap">
                {fileName}
                {isUnsaved && <span className="text-yellow-400 ml-1">*</span>}
              </span>
              <button
                className="p-0.5 rounded hover:bg-gray-600 text-gray-500 hover:text-white"
                onClick={(e) => handleCloseTab(path, e)}
                title="Close tab"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Editor in iframe */}
      <div className="flex-1">
        <iframe
          ref={iframeRef}
          src={iframeSrc.current}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
          }}
          title="Code Editor"
        />
      </div>
    </div>
  );
}

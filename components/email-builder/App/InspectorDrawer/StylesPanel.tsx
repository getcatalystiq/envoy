'use client';

import { setDocument, useDocument, useReadOnly } from '../../documents/editor/EditorContext';

import EmailLayoutSidebarPanel from './ConfigurationPanel/input-panels/EmailLayoutSidebarPanel';

export default function StylesPanel() {
  const block = useDocument().root;
  const readOnly = useReadOnly();

  if (!block) {
    return <p>Block not found</p>;
  }

  const { data, type } = block;
  if (type !== 'EmailLayout') {
    throw new Error('Expected "root" element to be of type EmailLayout');
  }

  // No-op setter when in read-only mode
  const setData = readOnly
    ? () => {}
    : (data: typeof block.data) => setDocument({ root: { type, data } });

  // When read-only, show a message at the top
  const readOnlyBanner = readOnly ? (
    <div className="mx-3 mt-3 p-2 bg-muted rounded-md">
      <span className="text-muted-foreground text-xs">View only - pause sequence to edit</span>
    </div>
  ) : null;

  return (
    <div className={readOnly ? 'pointer-events-none opacity-60' : ''}>
      {readOnlyBanner}
      <EmailLayoutSidebarPanel key="root" data={data} setData={setData} />
    </div>
  );
}

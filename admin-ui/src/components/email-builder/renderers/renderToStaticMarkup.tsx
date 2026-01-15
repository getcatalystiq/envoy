import { renderToStaticMarkup as baseRenderToStaticMarkup } from 'react-dom/server';
import { Reader, TReaderDocument } from '../Reader';

interface RenderOptions {
  rootBlockId: string;
}

export function renderToStaticMarkup(document: TReaderDocument, { rootBlockId }: RenderOptions): string {
  return (
    '<!DOCTYPE html>' +
    baseRenderToStaticMarkup(
      <html>
        <body>
          <Reader document={document} rootBlockId={rootBlockId} />
        </body>
      </html>
    )
  );
}

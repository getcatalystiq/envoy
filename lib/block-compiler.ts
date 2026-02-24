/**
 * Server-side block compiler for converting builder_content to HTML.
 * Port of functions/sequence_scheduler/block_compiler.py
 *
 * Converts the block-based email builder format to HTML that matches
 * the frontend React components for consistent email rendering.
 */

import { marked } from "marked";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyData = Record<string, any>;
type BlockMap = Record<string, AnyData>;

interface RenderContext {
  fontFamily: string | null;
  textColor: string | null;
}

const FONT_FAMILIES: Record<string, string> = {
  MODERN_SANS: '"Helvetica Neue", "Arial Nova", "Nimbus Sans", Arial, sans-serif',
  BOOK_SANS: 'Optima, Candara, "Noto Sans", source-sans-pro, sans-serif',
  ORGANIC_SANS: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
  GEOMETRIC_SANS: 'Avenir, "Avenir Next LT Pro", Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif',
  HEAVY_SANS: 'Bahnschrift, "DIN Alternate", "Franklin Gothic Medium", "Nimbus Sans Narrow", sans-serif-condensed, sans-serif',
  ROUNDED_SANS: 'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT Bold", Calibri, source-sans-pro, sans-serif',
  MODERN_SERIF: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
  BOOK_SERIF: '"Iowan Old Style", "Palatino Linotype", "URW Palladio L", P052, serif',
  MONOSPACE: '"Nimbus Mono PS", "Courier New", "Cutive Mono", monospace',
};

const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"]);

function getFontFamily(fontFamily: string | null | undefined): string | null {
  if (!fontFamily) return null;
  return FONT_FAMILIES[fontFamily] ?? null;
}

function getPadding(padding: AnyData | null | undefined): string | null {
  if (!padding) return null;
  return `${padding.top ?? 0}px ${padding.right ?? 0}px ${padding.bottom ?? 0}px ${padding.left ?? 0}px`;
}

function styleToString(styles: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(styles)) {
    if (value == null) continue;
    // camelCase to kebab-case
    const cssKey = key.replace(/([A-Z])/g, "-$1").toLowerCase();
    let cssValue = String(value);
    if (
      typeof value === "number" &&
      !["font-weight", "line-height", "opacity"].includes(cssKey)
    ) {
      cssValue = `${value}px`;
    }
    // Replace double quotes with single quotes for style attributes
    cssValue = cssValue.replace(/"/g, "'");
    parts.push(`${cssKey}: ${cssValue}`);
  }
  return parts.join("; ");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUrl(url: string | null | undefined): string {
  if (!url) return "";
  url = url.trim();
  if (url.includes(":")) {
    const scheme = url.split(":")[0].toLowerCase();
    if (!ALLOWED_SCHEMES.has(scheme)) return "";
  }
  return escapeHtml(url);
}

function sanitizeHtml(content: string): string {
  if (!content) return "";
  // Remove script and style tags
  content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // Remove event handlers
  content = content.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\s+on\w+\s*=\s*\S+/gi, "");
  // Remove javascript: URLs
  content = content.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href=""');
  return content;
}

function renderMarkdown(text: string): string {
  if (!text) return "";
  const rendered = marked.parse(text, { async: false }) as string;
  return sanitizeHtml(rendered);
}

function renderChildren(
  childrenIds: string[] | null | undefined,
  blocks: BlockMap,
  context: RenderContext
): string {
  if (!childrenIds) return "";
  return childrenIds.map((id) => renderBlock(id, blocks, context)).join("");
}

function renderBlock(
  blockId: string,
  blocks: BlockMap,
  context: RenderContext
): string {
  const block = blocks[blockId];
  if (!block) return "";

  const blockType = block.type;
  const data = block.data ?? {};

  const renderers: Record<
    string,
    (data: AnyData, blocks: BlockMap, ctx: RenderContext) => string
  > = {
    EmailLayout: renderEmailLayout,
    Container: renderContainer,
    ColumnsContainer: renderColumnsContainer,
    Text: renderText,
    Heading: renderHeading,
    Button: renderButton,
    Html: renderHtmlBlock,
    Image: renderImage,
    Divider: renderDivider,
    Spacer: renderSpacer,
    Avatar: renderAvatar,
  };

  const renderer = renderers[blockType];
  if (!renderer) return "";
  return renderer(data, blocks, context);
}

function renderEmailLayout(
  data: AnyData,
  blocks: BlockMap,
  context: RenderContext
): string {
  const backdropColor = data.backdropColor || "#F5F5F5";
  const canvasColor = data.canvasColor || "#FFFFFF";
  const textColor = data.textColor || "#262626";
  const fontFamily = getFontFamily(data.fontFamily);
  const borderColor = data.borderColor;
  const borderRadius = data.borderRadius;
  const childrenIds = data.childrenIds ?? [];

  context.fontFamily = fontFamily;
  context.textColor = textColor;

  const childrenHtml = renderChildren(childrenIds, blocks, context);

  const wrapperStyle = styleToString({
    backgroundColor: backdropColor,
    color: textColor,
    fontFamily,
    fontSize: 16,
    fontWeight: "400",
    letterSpacing: "0.15008px",
    lineHeight: "1.5",
    margin: "0",
    padding: "32px 0",
    minHeight: "100%",
    width: "100%",
  });

  const tableStyleParts = [
    "margin: 0 auto",
    "max-width: 600px",
    `background-color: ${canvasColor}`,
  ];
  if (borderRadius) tableStyleParts.push(`border-radius: ${borderRadius}px`);
  if (borderColor) tableStyleParts.push(`border: 1px solid ${borderColor}`);
  const tableStyle = tableStyleParts.join("; ");

  return `<div style="${wrapperStyle}">
  <table align="center" width="100%" style="${tableStyle}" role="presentation" cellspacing="0" cellpadding="0" border="0">
    <tbody>
      <tr style="width: 100%">
        <td>${childrenHtml}</td>
      </tr>
    </tbody>
  </table>
</div>`;
}

function renderContainer(
  data: AnyData,
  blocks: BlockMap,
  context: RenderContext
): string {
  const styleData = data.style ?? {};
  const props = data.props ?? {};
  const childrenIds = props.childrenIds ?? [];

  const styles: Record<string, unknown> = {
    backgroundColor: styleData.backgroundColor,
    borderRadius: styleData.borderRadius,
    padding: getPadding(styleData.padding),
  };

  if (styleData.borderColor) {
    styles.border = `1px solid ${styleData.borderColor}`;
  }

  const childrenHtml = renderChildren(childrenIds, blocks, context);
  const styleStr = styleToString(styles);
  return `<div style="${styleStr}">${childrenHtml}</div>`;
}

function renderColumnsContainer(
  data: AnyData,
  blocks: BlockMap,
  context: RenderContext
): string {
  const styleData = data.style ?? {};
  const props = data.props ?? {};

  const columnsCount: number = props.columnsCount || 2;
  const columnsGap: number = props.columnsGap || 0;
  const contentAlignment: string = props.contentAlignment || "middle";
  const fixedWidths: (string | null)[] = props.fixedWidths || [null, null, null];

  const wrapperStyle = styleToString({
    backgroundColor: styleData.backgroundColor,
    padding: getPadding(styleData.padding),
  });

  const column0Ids: string[] = data.childrenIds0 ?? [];
  const column1Ids: string[] = data.childrenIds1 ?? [];
  const column2Ids: string[] = data.childrenIds2 ?? [];

  function getPaddingBefore(index: number): number {
    if (index === 0) return 0;
    if (columnsCount === 2) return columnsGap / 2;
    if (index === 1) return columnsGap / 3;
    return (2 * columnsGap) / 3;
  }

  function getPaddingAfter(index: number): number {
    if (columnsCount === 2) return index === 0 ? columnsGap / 2 : 0;
    if (index === 0) return (2 * columnsGap) / 3;
    if (index === 1) return columnsGap / 3;
    return 0;
  }

  function renderTableCell(index: number, childIds: string[]): string {
    if (columnsCount === 2 && index === 2) return "";

    const cellStyle = styleToString({
      boxSizing: "content-box",
      verticalAlign: contentAlignment,
      paddingLeft: getPaddingBefore(index),
      paddingRight: getPaddingAfter(index),
      width: index < fixedWidths.length ? fixedWidths[index] : null,
    });

    const childrenHtml = renderChildren(childIds, blocks, context);
    return `<td style="${cellStyle}">${childrenHtml}</td>`;
  }

  const cellsHtml = [
    renderTableCell(0, column0Ids),
    renderTableCell(1, column1Ids),
    renderTableCell(2, column2Ids),
  ].join("");

  return `<div style="${wrapperStyle}">
  <table align="center" width="100%" cellpadding="0" border="0" style="table-layout: fixed; border-collapse: collapse">
    <tbody style="width: 100%">
      <tr style="width: 100%">${cellsHtml}</tr>
    </tbody>
  </table>
</div>`;
}

function renderText(
  data: AnyData,
  _blocks: BlockMap,
  context: RenderContext
): string {
  const styleData = data.style ?? {};
  const props = data.props ?? {};
  const text = props.text || "";

  const styles = {
    color: styleData.color || context.textColor,
    backgroundColor: styleData.backgroundColor,
    fontSize: styleData.fontSize,
    fontFamily: getFontFamily(styleData.fontFamily) || context.fontFamily,
    fontWeight: styleData.fontWeight,
    textAlign: styleData.textAlign,
    padding: getPadding(styleData.padding),
  };

  const styleStr = styleToString(styles);
  const htmlContent = renderMarkdown(text);
  return `<div style="${styleStr}">${htmlContent}</div>`;
}

function renderHeading(
  data: AnyData,
  _blocks: BlockMap,
  context: RenderContext
): string {
  const styleData = data.style ?? {};
  const props = data.props ?? {};

  const level = props.level || "h2";
  const text = escapeHtml(props.text || "");

  const fontSizes: Record<string, number> = { h1: 32, h2: 24, h3: 20 };

  const styles = {
    color: styleData.color || context.textColor,
    backgroundColor: styleData.backgroundColor,
    fontWeight: styleData.fontWeight || "bold",
    textAlign: styleData.textAlign,
    margin: "0",
    fontFamily: getFontFamily(styleData.fontFamily) || context.fontFamily,
    fontSize: fontSizes[level] ?? 24,
    padding: getPadding(styleData.padding),
  };

  const styleStr = styleToString(styles);
  return `<${level} style="${styleStr}">${text}</${level}>`;
}

function renderButton(
  data: AnyData,
  _blocks: BlockMap,
  context: RenderContext
): string {
  const styleData = data.style ?? {};
  const props = data.props ?? {};

  const text = escapeHtml(props.text || "");
  const url = sanitizeUrl(props.url);
  const fullWidth = props.fullWidth || false;
  const buttonTextColor = props.buttonTextColor || "#FFFFFF";
  const buttonBgColor = props.buttonBackgroundColor || "#999999";
  const buttonStyle = props.buttonStyle || "rounded";
  const size = props.size || "medium";

  const borderRadiusMap: Record<string, number | null> = {
    rectangle: null,
    pill: 64,
    rounded: 4,
  };
  const borderRadius = borderRadiusMap[buttonStyle] ?? null;

  const sizePaddingMap: Record<string, [number, number]> = {
    "x-small": [4, 8],
    small: [8, 12],
    medium: [12, 20],
    large: [16, 32],
  };
  const [vPad, hPad] = sizePaddingMap[size] ?? [12, 20];
  const textRaise = Math.floor((hPad * 2 * 3) / 4);

  const wrapperStyle = styleToString({
    backgroundColor: styleData.backgroundColor,
    textAlign: styleData.textAlign,
    padding: getPadding(styleData.padding),
  });

  const linkStyles = {
    color: buttonTextColor,
    fontSize: styleData.fontSize || 16,
    fontFamily: getFontFamily(styleData.fontFamily) || context.fontFamily,
    fontWeight: styleData.fontWeight || "bold",
    backgroundColor: buttonBgColor,
    borderRadius,
    display: fullWidth ? "block" : "inline-block",
    padding: `${vPad}px ${hPad}px`,
    textDecoration: "none",
  };

  const linkStyleStr = styleToString(linkStyles);
  const msoBefore = `<!--[if mso]><i style="letter-spacing: ${hPad}px;mso-font-width:-100%;mso-text-raise:${textRaise}" hidden>&nbsp;</i><![endif]-->`;
  const msoAfter = `<!--[if mso]><i style="letter-spacing: ${hPad}px;mso-font-width:-100%" hidden>&nbsp;</i><![endif]-->`;

  return `<div style="${wrapperStyle}">
  <a href="${url}" style="${linkStyleStr}" target="_blank">
    ${msoBefore}
    <span>${text}</span>
    ${msoAfter}
  </a>
</div>`;
}

function renderHtmlBlock(
  data: AnyData,
  _blocks: BlockMap,
  context: RenderContext
): string {
  const styleData = data.style ?? {};
  const props = data.props ?? {};
  const contents = sanitizeHtml(props.contents || "");

  const styles = {
    color: styleData.color || context.textColor,
    backgroundColor: styleData.backgroundColor,
    fontFamily: getFontFamily(styleData.fontFamily) || context.fontFamily,
    fontSize: styleData.fontSize,
    textAlign: styleData.textAlign,
    padding: getPadding(styleData.padding),
  };

  const styleStr = styleToString(styles);
  return `<div style="${styleStr}">${contents}</div>`;
}

function renderImage(
  data: AnyData,
  _blocks: BlockMap,
  _context: RenderContext
): string {
  const styleData = data.style ?? {};
  const props = data.props ?? {};

  const url = sanitizeUrl(props.url);
  const alt = escapeHtml(props.alt || "");
  const width = props.width;
  const height = props.height;
  const linkHref = sanitizeUrl(props.linkHref);
  const contentAlignment = props.contentAlignment || "middle";

  const sectionStyle = styleToString({
    padding: getPadding(styleData.padding),
    backgroundColor: styleData.backgroundColor,
    textAlign: styleData.textAlign,
  });

  const imgStyleParts = [
    "outline: none",
    "border: none",
    "text-decoration: none",
    `vertical-align: ${contentAlignment}`,
    "display: inline-block",
    "max-width: 100%",
  ];
  if (width) imgStyleParts.push(`width: ${width}px`);
  if (height) imgStyleParts.push(`height: ${height}px`);
  const imgStyle = imgStyleParts.join("; ");

  const widthAttr = width ? ` width="${width}"` : "";
  const heightAttr = height ? ` height="${height}"` : "";

  let imgTag = `<img alt="${alt}" src="${url}"${widthAttr}${heightAttr} style="${imgStyle}" />`;
  if (linkHref) {
    imgTag = `<a href="${linkHref}" style="text-decoration: none" target="_blank">${imgTag}</a>`;
  }

  return `<div style="${sectionStyle}">${imgTag}</div>`;
}

function renderDivider(
  data: AnyData,
  _blocks: BlockMap,
  _context: RenderContext
): string {
  const styleData = data.style ?? {};
  const props = data.props ?? {};

  const lineHeight = props.lineHeight || 1;
  const lineColor = props.lineColor || "#333333";

  const wrapperStyle = styleToString({
    padding: getPadding(styleData.padding),
    backgroundColor: styleData.backgroundColor,
  });

  const hrStyle = `width: 100%; border: none; border-top: ${lineHeight}px solid ${lineColor}; margin: 0`;
  return `<div style="${wrapperStyle}"><hr style="${hrStyle}" /></div>`;
}

function renderSpacer(
  data: AnyData,
  _blocks: BlockMap,
  _context: RenderContext
): string {
  const props = data.props ?? {};
  const height = props.height || 16;
  return `<div style="height: ${height}px"></div>`;
}

function renderAvatar(
  data: AnyData,
  _blocks: BlockMap,
  _context: RenderContext
): string {
  const styleData = data.style ?? {};
  const props = data.props ?? {};

  const url = sanitizeUrl(props.url);
  const alt = escapeHtml(props.alt || "");
  const size = props.size || 64;

  const sectionStyle = styleToString({
    padding: getPadding(styleData.padding),
    backgroundColor: styleData.backgroundColor,
    textAlign: styleData.textAlign || "center",
  });

  const imgStyle = `width: ${size}px; height: ${size}px; border-radius: 50%; object-fit: cover; display: inline-block`;
  return `<div style="${sectionStyle}"><img alt="${alt}" src="${url}" style="${imgStyle}" /></div>`;
}

export function compileBuilderContent(
  builderContent: BlockMap,
  rootBlockId: string = "root"
): string {
  if (!builderContent) return "";

  const rootBlock = builderContent[rootBlockId];
  if (!rootBlock) return "";

  const context: RenderContext = { fontFamily: null, textColor: null };
  return renderBlock(rootBlockId, builderContent, context);
}

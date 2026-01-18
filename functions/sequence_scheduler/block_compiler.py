"""Server-side block compiler for converting builder_content to HTML.

This module converts the block-based email builder format to HTML that matches
the frontend React components for consistent email rendering.
"""

import html
import re
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

import mistune


# Font family mappings (matching frontend shared/schemas.ts)
FONT_FAMILIES: dict[str, str] = {
    "MODERN_SANS": '"Helvetica Neue", "Arial Nova", "Nimbus Sans", Arial, sans-serif',
    "BOOK_SANS": 'Optima, Candara, "Noto Sans", source-sans-pro, sans-serif',
    "ORGANIC_SANS": 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
    "GEOMETRIC_SANS": 'Avenir, "Avenir Next LT Pro", Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif',
    "HEAVY_SANS": 'Bahnschrift, "DIN Alternate", "Franklin Gothic Medium", "Nimbus Sans Narrow", sans-serif-condensed, sans-serif',
    "ROUNDED_SANS": 'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT Bold", Calibri, source-sans-pro, sans-serif',
    "MODERN_SERIF": 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
    "BOOK_SERIF": '"Iowan Old Style", "Palatino Linotype", "URW Palladio L", P052, serif',
    "MONOSPACE": '"Nimbus Mono PS", "Courier New", "Cutive Mono", monospace',
}

# Allowed HTML tags for sanitization (matching frontend EmailMarkdown.tsx)
ALLOWED_TAGS = {
    "a", "article", "b", "blockquote", "br", "caption", "code", "del", "details",
    "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins",
    "kbd", "li", "main", "ol", "p", "pre", "section", "span", "strong", "sub",
    "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
}

# Safe URL schemes
ALLOWED_SCHEMES = {"http", "https", "mailto"}


@dataclass
class RenderContext:
    """Context passed down during block rendering."""

    font_family: str | None = None
    text_color: str | None = None


def get_font_family(font_family: str | None) -> str | None:
    """Convert font family enum to CSS font-family string."""
    if not font_family:
        return None
    return FONT_FAMILIES.get(font_family)


def get_padding(padding: dict[str, int] | None) -> str | None:
    """Convert padding object to CSS padding string."""
    if not padding:
        return None
    return f"{padding.get('top', 0)}px {padding.get('right', 0)}px {padding.get('bottom', 0)}px {padding.get('left', 0)}px"


def style_to_string(styles: dict[str, Any]) -> str:
    """Convert a style dict to inline CSS string."""
    parts = []
    for key, value in styles.items():
        if value is None:
            continue
        # Convert camelCase to kebab-case
        css_key = re.sub(r"([A-Z])", r"-\1", key).lower()
        # Handle numeric values (assume px for most properties)
        if isinstance(value, (int, float)) and css_key not in ("font-weight", "line-height", "opacity"):
            value = f"{value}px"
        # Replace double quotes with single quotes in string values to avoid
        # breaking HTML style attributes (e.g., font-family values)
        if isinstance(value, str):
            value = value.replace('"', "'")
        parts.append(f"{css_key}: {value}")
    return "; ".join(parts)


def sanitize_url(url: str | None) -> str:
    """Sanitize URL to prevent XSS attacks."""
    if not url:
        return ""
    url = url.strip()
    # Check URL scheme
    if ":" in url:
        scheme = url.split(":")[0].lower()
        if scheme not in ALLOWED_SCHEMES:
            return ""
    return html.escape(url, quote=True)


def sanitize_html(content: str) -> str:
    """Sanitize HTML content to only allow safe tags and attributes."""
    if not content:
        return ""

    # Remove script and style tags entirely
    content = re.sub(r"<script[^>]*>.*?</script>", "", content, flags=re.IGNORECASE | re.DOTALL)
    content = re.sub(r"<style[^>]*>.*?</style>", "", content, flags=re.IGNORECASE | re.DOTALL)

    # Remove event handlers (on*)
    content = re.sub(r'\s+on\w+\s*=\s*["\'][^"\']*["\']', "", content, flags=re.IGNORECASE)
    content = re.sub(r"\s+on\w+\s*=\s*\S+", "", content, flags=re.IGNORECASE)

    # Remove javascript: URLs
    content = re.sub(r'href\s*=\s*["\']javascript:[^"\']*["\']', 'href=""', content, flags=re.IGNORECASE)

    return content


class EmailMarkdownRenderer(mistune.HTMLRenderer):
    """Custom markdown renderer matching frontend EmailMarkdown component."""

    def link(self, text: str, url: str, title: str | None = None) -> str:
        safe_url = sanitize_url(url)
        if title:
            return f'<a href="{safe_url}" title="{html.escape(title)}" target="_blank">{text}</a>'
        return f'<a href="{safe_url}" target="_blank">{text}</a>'

    def table(self, text: str) -> str:
        return f'<table width="100%">\n{text}\n</table>'


def render_markdown(text: str) -> str:
    """Render markdown text to HTML matching frontend EmailMarkdown component."""
    if not text:
        return ""

    md = mistune.create_markdown(
        renderer=EmailMarkdownRenderer(),
        plugins=["table", "strikethrough"],
    )
    rendered = md(text)
    return sanitize_html(rendered)


def compile_builder_content(
    builder_content: dict[str, dict[str, Any]],
    root_block_id: str = "root",
) -> str:
    """Convert builder_content to HTML string.

    Args:
        builder_content: Dict mapping block IDs to block definitions
        root_block_id: ID of the root block (default "root")

    Returns:
        Complete HTML string ready for email sending
    """
    if not builder_content:
        return ""

    root_block = builder_content.get(root_block_id)
    if not root_block:
        return ""

    context = RenderContext()
    return render_block(root_block_id, builder_content, context)


def render_block(block_id: str, blocks: dict[str, dict[str, Any]], context: RenderContext) -> str:
    """Recursively render a single block and its children."""
    block = blocks.get(block_id)
    if not block:
        return ""

    block_type = block.get("type")
    data = block.get("data", {})

    renderers = {
        "EmailLayout": render_email_layout,
        "Container": render_container,
        "ColumnsContainer": render_columns_container,
        "Text": render_text,
        "Heading": render_heading,
        "Button": render_button,
        "Html": render_html_block,
        "Image": render_image,
        "Divider": render_divider,
        "Spacer": render_spacer,
        "Avatar": render_avatar,
    }

    renderer = renderers.get(block_type)
    if not renderer:
        return ""

    return renderer(data, blocks, context)


def render_children(children_ids: list[str] | None, blocks: dict, context: RenderContext) -> str:
    """Render a list of child blocks."""
    if not children_ids:
        return ""
    return "".join(render_block(child_id, blocks, context) for child_id in children_ids)


def render_email_layout(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render the root EmailLayout block."""
    backdrop_color = data.get("backdropColor") or "#F5F5F5"
    canvas_color = data.get("canvasColor") or "#FFFFFF"
    text_color = data.get("textColor") or "#262626"
    font_family = get_font_family(data.get("fontFamily"))
    border_color = data.get("borderColor")
    border_radius = data.get("borderRadius")
    children_ids = data.get("childrenIds", [])

    # Update context for child blocks
    context.font_family = font_family
    context.text_color = text_color

    children_html = render_children(children_ids, blocks, context)

    wrapper_style = style_to_string({
        "backgroundColor": backdrop_color,
        "color": text_color,
        "fontFamily": font_family,
        "fontSize": 16,
        "fontWeight": "400",
        "letterSpacing": "0.15008px",
        "lineHeight": "1.5",
        "margin": "0",
        "padding": "32px 0",
        "minHeight": "100%",
        "width": "100%",
    })

    table_style_parts = [
        "margin: 0 auto",
        "max-width: 600px",
        f"background-color: {canvas_color}",
    ]
    if border_radius:
        table_style_parts.append(f"border-radius: {border_radius}px")
    if border_color:
        table_style_parts.append(f"border: 1px solid {border_color}")
    table_style = "; ".join(table_style_parts)

    return f'''<div style="{wrapper_style}">
  <table align="center" width="100%" style="{table_style}" role="presentation" cellspacing="0" cellpadding="0" border="0">
    <tbody>
      <tr style="width: 100%">
        <td>{children_html}</td>
      </tr>
    </tbody>
  </table>
</div>'''


def render_container(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render a Container block."""
    style_data = data.get("style", {}) or {}
    props = data.get("props", {}) or {}
    children_ids = props.get("childrenIds", [])

    styles = {
        "backgroundColor": style_data.get("backgroundColor"),
        "borderRadius": style_data.get("borderRadius"),
        "padding": get_padding(style_data.get("padding")),
    }

    border_color = style_data.get("borderColor")
    if border_color:
        styles["border"] = f"1px solid {border_color}"

    children_html = render_children(children_ids, blocks, context)
    style_str = style_to_string(styles)

    if not children_html:
        return f'<div style="{style_str}"></div>'
    return f'<div style="{style_str}">{children_html}</div>'


def render_columns_container(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render a ColumnsContainer block with multi-column layout."""
    style_data = data.get("style", {}) or {}
    props = data.get("props", {}) or {}

    columns_count: Literal[2, 3] = props.get("columnsCount") or 2
    columns_gap = props.get("columnsGap") or 0
    content_alignment = props.get("contentAlignment") or "middle"
    fixed_widths = props.get("fixedWidths") or [None, None, None]

    wrapper_style = style_to_string({
        "backgroundColor": style_data.get("backgroundColor"),
        "padding": get_padding(style_data.get("padding")),
    })

    # Get column children
    column0_ids = data.get("childrenIds0", [])
    column1_ids = data.get("childrenIds1", [])
    column2_ids = data.get("childrenIds2", [])

    def get_padding_before(index: int) -> float:
        if index == 0:
            return 0
        if columns_count == 2:
            return columns_gap / 2
        if index == 1:
            return columns_gap / 3
        return (2 * columns_gap) / 3

    def get_padding_after(index: int) -> float:
        if columns_count == 2:
            return columns_gap / 2 if index == 0 else 0
        if index == 0:
            return (2 * columns_gap) / 3
        if index == 1:
            return columns_gap / 3
        return 0

    def render_table_cell(index: int, children_ids: list[str]) -> str:
        if columns_count == 2 and index == 2:
            return ""

        cell_style = style_to_string({
            "boxSizing": "content-box",
            "verticalAlign": content_alignment,
            "paddingLeft": get_padding_before(index),
            "paddingRight": get_padding_after(index),
            "width": fixed_widths[index] if index < len(fixed_widths) else None,
        })

        children_html = render_children(children_ids, blocks, context)
        return f'<td style="{cell_style}">{children_html}</td>'

    cells_html = "".join([
        render_table_cell(0, column0_ids),
        render_table_cell(1, column1_ids),
        render_table_cell(2, column2_ids),
    ])

    return f'''<div style="{wrapper_style}">
  <table align="center" width="100%" cellpadding="0" border="0" style="table-layout: fixed; border-collapse: collapse">
    <tbody style="width: 100%">
      <tr style="width: 100%">{cells_html}</tr>
    </tbody>
  </table>
</div>'''


def render_text(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render a Text block with markdown support."""
    style_data = data.get("style", {}) or {}
    props = data.get("props", {}) or {}

    text = props.get("text") or ""

    styles = {
        "color": style_data.get("color") or context.text_color,
        "backgroundColor": style_data.get("backgroundColor"),
        "fontSize": style_data.get("fontSize"),
        "fontFamily": get_font_family(style_data.get("fontFamily")) or context.font_family,
        "fontWeight": style_data.get("fontWeight"),
        "textAlign": style_data.get("textAlign"),
        "padding": get_padding(style_data.get("padding")),
    }

    style_str = style_to_string(styles)
    html_content = render_markdown(text)

    return f'<div style="{style_str}">{html_content}</div>'


def render_heading(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render a Heading block (h1/h2/h3)."""
    style_data = data.get("style", {}) or {}
    props = data.get("props", {}) or {}

    level = props.get("level") or "h2"
    text = html.escape(props.get("text") or "")

    font_sizes = {"h1": 32, "h2": 24, "h3": 20}

    styles = {
        "color": style_data.get("color") or context.text_color,
        "backgroundColor": style_data.get("backgroundColor"),
        "fontWeight": style_data.get("fontWeight") or "bold",
        "textAlign": style_data.get("textAlign"),
        "margin": "0",
        "fontFamily": get_font_family(style_data.get("fontFamily")) or context.font_family,
        "fontSize": font_sizes.get(level, 24),
        "padding": get_padding(style_data.get("padding")),
    }

    style_str = style_to_string(styles)
    return f'<{level} style="{style_str}">{text}</{level}>'


def render_button(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render a Button block with MSO compatibility."""
    style_data = data.get("style", {}) or {}
    props = data.get("props", {}) or {}

    text = html.escape(props.get("text") or "")
    url = sanitize_url(props.get("url"))
    full_width = props.get("fullWidth") or False
    button_text_color = props.get("buttonTextColor") or "#FFFFFF"
    button_bg_color = props.get("buttonBackgroundColor") or "#999999"
    button_style = props.get("buttonStyle") or "rounded"
    size = props.get("size") or "medium"

    # Border radius based on button style
    border_radius_map = {"rectangle": None, "pill": 64, "rounded": 4}
    border_radius = border_radius_map.get(button_style)

    # Padding based on size
    size_padding_map = {
        "x-small": (4, 8),
        "small": (8, 12),
        "medium": (12, 20),
        "large": (16, 32),
    }
    v_pad, h_pad = size_padding_map.get(size, (12, 20))
    text_raise = (h_pad * 2 * 3) // 4

    wrapper_style = style_to_string({
        "backgroundColor": style_data.get("backgroundColor"),
        "textAlign": style_data.get("textAlign"),
        "padding": get_padding(style_data.get("padding")),
    })

    link_styles = {
        "color": button_text_color,
        "fontSize": style_data.get("fontSize") or 16,
        "fontFamily": get_font_family(style_data.get("fontFamily")) or context.font_family,
        "fontWeight": style_data.get("fontWeight") or "bold",
        "backgroundColor": button_bg_color,
        "borderRadius": border_radius,
        "display": "block" if full_width else "inline-block",
        "padding": f"{v_pad}px {h_pad}px",
        "textDecoration": "none",
    }

    link_style_str = style_to_string(link_styles)

    # MSO compatibility comments for Outlook
    mso_before = f'<!--[if mso]><i style="letter-spacing: {h_pad}px;mso-font-width:-100%;mso-text-raise:{text_raise}" hidden>&nbsp;</i><![endif]-->'
    mso_after = f'<!--[if mso]><i style="letter-spacing: {h_pad}px;mso-font-width:-100%" hidden>&nbsp;</i><![endif]-->'

    return f'''<div style="{wrapper_style}">
  <a href="{url}" style="{link_style_str}" target="_blank">
    {mso_before}
    <span>{text}</span>
    {mso_after}
  </a>
</div>'''


def render_html_block(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render a raw HTML block with sanitization."""
    style_data = data.get("style", {}) or {}
    props = data.get("props", {}) or {}

    contents = sanitize_html(props.get("contents") or "")

    styles = {
        "color": style_data.get("color") or context.text_color,
        "backgroundColor": style_data.get("backgroundColor"),
        "fontFamily": get_font_family(style_data.get("fontFamily")) or context.font_family,
        "fontSize": style_data.get("fontSize"),
        "textAlign": style_data.get("textAlign"),
        "padding": get_padding(style_data.get("padding")),
    }

    style_str = style_to_string(styles)

    if not contents:
        return f'<div style="{style_str}"></div>'
    return f'<div style="{style_str}">{contents}</div>'


def render_image(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render an Image block."""
    style_data = data.get("style", {}) or {}
    props = data.get("props", {}) or {}

    url = sanitize_url(props.get("url"))
    alt = html.escape(props.get("alt") or "")
    width = props.get("width")
    height = props.get("height")
    link_href = sanitize_url(props.get("linkHref"))
    content_alignment = props.get("contentAlignment") or "middle"

    section_style = style_to_string({
        "padding": get_padding(style_data.get("padding")),
        "backgroundColor": style_data.get("backgroundColor"),
        "textAlign": style_data.get("textAlign"),
    })

    img_style_parts = [
        "outline: none",
        "border: none",
        "text-decoration: none",
        f"vertical-align: {content_alignment}",
        "display: inline-block",
        "max-width: 100%",
    ]
    if width:
        img_style_parts.append(f"width: {width}px")
    if height:
        img_style_parts.append(f"height: {height}px")
    img_style = "; ".join(img_style_parts)

    width_attr = f' width="{width}"' if width else ""
    height_attr = f' height="{height}"' if height else ""

    img_tag = f'<img alt="{alt}" src="{url}"{width_attr}{height_attr} style="{img_style}" />'

    if link_href:
        img_tag = f'<a href="{link_href}" style="text-decoration: none" target="_blank">{img_tag}</a>'

    return f'<div style="{section_style}">{img_tag}</div>'


def render_divider(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render a Divider block."""
    style_data = data.get("style", {}) or {}
    props = data.get("props", {}) or {}

    line_height = props.get("lineHeight") or 1
    line_color = props.get("lineColor") or "#333333"

    wrapper_style = style_to_string({
        "padding": get_padding(style_data.get("padding")),
        "backgroundColor": style_data.get("backgroundColor"),
    })

    hr_style = f"width: 100%; border: none; border-top: {line_height}px solid {line_color}; margin: 0"

    return f'<div style="{wrapper_style}"><hr style="{hr_style}" /></div>'


def render_spacer(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render a Spacer block."""
    props = data.get("props", {}) or {}

    height = props.get("height") or 16

    return f'<div style="height: {height}px"></div>'


def render_avatar(data: dict, blocks: dict, context: RenderContext) -> str:
    """Render an Avatar block (circular image)."""
    style_data = data.get("style", {}) or {}
    props = data.get("props", {}) or {}

    url = sanitize_url(props.get("url"))
    alt = html.escape(props.get("alt") or "")
    size = props.get("size") or 64

    section_style = style_to_string({
        "padding": get_padding(style_data.get("padding")),
        "backgroundColor": style_data.get("backgroundColor"),
        "textAlign": style_data.get("textAlign") or "center",
    })

    img_style = f"width: {size}px; height: {size}px; border-radius: 50%; object-fit: cover; display: inline-block"

    return f'<div style="{section_style}"><img alt="{alt}" src="{url}" style="{img_style}" /></div>'

"""MJML compilation and email rendering."""
from mjml import mjml_to_html
from jinja2 import Environment, BaseLoader, select_autoescape
from premailer import transform
import html2text

# Module-level configuration
_jinja_env = Environment(
    loader=BaseLoader(),
    autoescape=select_autoescape(["html", "xml"]),
)

_html_to_text = html2text.HTML2Text()
_html_to_text.ignore_links = False
_html_to_text.ignore_images = True

# Default sample data for previews
_DEFAULT_SAMPLE_DATA = {
    "first_name": "Alex",
    "last_name": "Johnson",
    "company": "Acme Corp",
    "title": "Product Manager",
    "email": "alex@example.com",
    "content_body": "<p>This is sample email body content.</p>",
    "content_subject": "Sample Email Subject",
}


def compile(mjml_source: str) -> tuple[str, list[str]]:
    """
    Compile MJML to HTML.
    Returns (html, errors).
    """
    result = mjml_to_html(mjml_source)
    return result.html, result.errors or []


def render(
    mjml_source: str,
    variables: dict,
    content_body: str = "",
    content_subject: str = "",
) -> tuple[str, str, str]:
    """
    Render email with template + content.

    1. Substitute content into template slots
    2. Resolve all Jinja2 variables
    3. Compile MJML to HTML
    4. Inline CSS

    Returns (subject, html, text).
    """
    # Merge content into template
    full_context = {
        **variables,
        "content_body": content_body,
        "content_subject": content_subject,
    }

    # Render Jinja2 variables in MJML
    template = _jinja_env.from_string(mjml_source)
    rendered_mjml = template.render(**full_context)

    # Compile MJML to HTML
    html_raw, errors = compile(rendered_mjml)
    if errors:
        raise ValueError(f"MJML compilation errors: {errors}")

    # Inline CSS for email client compatibility
    html_inlined = transform(
        html_raw,
        remove_classes=False,
        strip_important=False,
        keep_style_tags=True,
    )

    # Generate plain text
    text_content = _html_to_text.handle(html_inlined)

    # Render subject
    subject_template = _jinja_env.from_string(content_subject)
    rendered_subject = subject_template.render(**variables)

    return rendered_subject, html_inlined, text_content


def preview(mjml_source: str, sample_data: dict = None) -> tuple[str, str]:
    """
    Generate preview HTML for template editor.
    Returns (html, text).
    """
    data = {**_DEFAULT_SAMPLE_DATA, **(sample_data or {})}

    template = _jinja_env.from_string(mjml_source)
    rendered_mjml = template.render(**data)

    html, _ = compile(rendered_mjml)
    text = _html_to_text.handle(html)

    return html, text

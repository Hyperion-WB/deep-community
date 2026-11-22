import bleach

# 允许的安全 HTML 标签
ALLOWED_TAGS = [
    'a', 'abbr', 'acronym', 'b', 'blockquote', 'code', 'em', 'i', 'li', 'ol',
    'strong', 'ul', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr',
    'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'span', 'del',
    'sup', 'sub', 'details', 'summary'
]

# 允许的安全属性
ALLOWED_ATTRIBUTES = {
    '*': ['class', 'id', 'title'],
    'a': ['href', 'title', 'target', 'rel'],
    'img': ['src', 'alt', 'title', 'width', 'height', 'loading'],
    'code': ['class'],
    'pre': ['class'],
    'th': ['align', 'colspan', 'rowspan'],
    'td': ['align', 'colspan', 'rowspan'],
}

# 允许的安全协议
ALLOWED_PROTOCOLS = ['http', 'https', 'mailto']

def clean_html(dirty_html: str) -> str:
    """使用 Bleach 进行严格的 HTML 白名单清洗，防 XSS 跨站脚本攻击"""
    if not dirty_html:
        return ""
    cleaned = bleach.clean(
        dirty_html,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        protocols=ALLOWED_PROTOCOLS,
        strip=True
    )
    return bleach.linkify(cleaned)

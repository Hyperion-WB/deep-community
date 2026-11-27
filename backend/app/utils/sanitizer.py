import re
import warnings

import bleach


_RICH_TYPOGRAPHY_TAG = re.compile(
    r'<span class="wb-typography-(?:underline-(?:straight|wavy)|size-(?:12|14|16|18|20|24|28|32)'
    r'|font-(?:sans|serif|mono)|color-(?:red|orange|green|blue|purple|gray)'
    r'|highlight-(?:yellow|green|blue|purple|pink)|align-(?:left|center|right|justify))">'
    r'|</span>|</?(?:u|em|strong)>',
    re.IGNORECASE,
)


def strip_rich_typography(markdown: str) -> str:
    """从按纯文本处理的 Markdown 中移除排版标记。"""
    return _RICH_TYPOGRAPHY_TAG.sub('', markdown)

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
    'span': ['class', 'id', 'title', 'data-wb-color', 'data-wb-bg'],
    'a': ['href', 'title', 'target', 'rel'],
    'img': ['src', 'alt', 'title', 'width', 'height', 'loading'],
    'code': ['class'],
    'pre': ['class'],
    'th': ['align', 'colspan', 'rowspan'],
    'td': ['align', 'colspan', 'rowspan'],
}

# 允许的安全协议
ALLOWED_PROTOCOLS = ['http', 'https', 'mailto']

_STYLE_HEX = re.compile(r'^(color|background-color)\s*:\s*(#[0-9a-fA-F]{6})$')
_SPAN_TAG = re.compile(r'<span\b([^>]*)>', re.IGNORECASE)


def _prepare_inline_styles(html: str) -> str:
    """把 span 上合法的 color/background-color 暂存为 data-*，绕过 Bleach 的 CSS 清空。"""
    def replace(match: re.Match) -> str:
        attrs = match.group(1)
        style_match = re.search(r'\sstyle="([^"]*)"', attrs, re.IGNORECASE)
        if not style_match:
            return match.group(0)
        color = background = None
        for part in style_match.group(1).split(';'):
            parsed = _STYLE_HEX.match(part.strip())
            if not parsed:
                continue
            if parsed.group(1).lower() == 'color':
                color = parsed.group(2).lower()
            else:
                background = parsed.group(2).lower()
        attrs = re.sub(r'\sstyle="[^"]*"', '', attrs, flags=re.IGNORECASE)
        attrs = re.sub(r'\sdata-wb-(?:color|bg)="[^"]*"', '', attrs, flags=re.IGNORECASE)
        if color:
            attrs += f' data-wb-color="{color}"'
        if background:
            attrs += f' data-wb-bg="{background}"'
        return f'<span{attrs}>'
    return _SPAN_TAG.sub(replace, html)


def _restore_inline_styles(html: str) -> str:
    def replace(match: re.Match) -> str:
        attrs = match.group(1)
        color = re.search(r'\sdata-wb-color="#([0-9a-fA-F]{6})"', attrs)
        background = re.search(r'\sdata-wb-bg="#([0-9a-fA-F]{6})"', attrs)
        attrs = re.sub(r'\sdata-wb-(?:color|bg)="[^"]*"', '', attrs, flags=re.IGNORECASE)
        styles = []
        if color:
            styles.append(f'color: #{color.group(1).lower()}')
        if background:
            styles.append(f'background-color: #{background.group(1).lower()}')
        style_attr = f' style="{"; ".join(styles)}"' if styles else ''
        return f'<span{attrs}{style_attr}>'
    return _SPAN_TAG.sub(replace, html)


def clean_html(dirty_html: str) -> str:
    """使用 Bleach 进行严格的 HTML 白名单清洗，防 XSS 跨站脚本攻击"""
    if not dirty_html:
        return ""
    prepared = _prepare_inline_styles(dirty_html)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        cleaned = bleach.clean(
            prepared,
            tags=ALLOWED_TAGS,
            attributes=ALLOWED_ATTRIBUTES,
            protocols=ALLOWED_PROTOCOLS,
            strip=True,
        )
    cleaned = _restore_inline_styles(cleaned)
    return bleach.linkify(cleaned)

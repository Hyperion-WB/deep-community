"""SMTP 邮件投递服务。

设计原则：
- 未配置 SMTP 时不阻塞业务（仅写服务端日志），方便本地/内网自测；
- 使用标准库 smtplib + asyncio.to_thread，避免额外依赖；
- 邮件正文同时提供纯文本与 HTML 版本，降低被判垃圾邮件的概率。
"""

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from typing import Optional, Tuple

from app.core.config import settings

logger = logging.getLogger("community.email")

PURPOSE_LABELS = {
    "register": "注册验证",
    "reset": "重置登录密码",
    "bind_email": "绑定/更换邮箱",
}


def is_email_configured() -> bool:
    """SMTP 是否已配置（Host 与发件人至少存在一个）。"""
    return bool(settings.SMTP_HOST and (settings.SMTP_FROM or settings.SMTP_USERNAME))


def _sender_address() -> str:
    return (settings.SMTP_FROM or settings.SMTP_USERNAME or "").strip()


def _send_sync(to: str, subject: str, html: str, text: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("极客社区", _sender_address()))
    msg["To"] = to
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")

    context = ssl.create_default_context()
    timeout = settings.SMTP_TIMEOUT_SECONDS
    if settings.SMTP_USE_SSL:
        with smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, timeout=timeout, context=context) as server:
            if settings.SMTP_USERNAME:
                server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            server.send_message(msg)
    else:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=timeout) as server:
            server.ehlo()
            if settings.SMTP_USE_STARTTLS:
                server.starttls(context=context)
                server.ehlo()
            if settings.SMTP_USERNAME:
                server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            server.send_message(msg)


async def send_email(to: str, subject: str, html: str, text: str) -> bool:
    """发送邮件；返回是否真正投递成功（未配置 SMTP 视为未投递）。"""
    if not is_email_configured():
        logger.warning("[email] SMTP 未配置，跳过投递 to=%s subject=%s", to, subject)
        print(f"[email] SMTP 未配置，邮件未发送：to={to} subject={subject}")
        return False
    try:
        await asyncio.to_thread(_send_sync, to, subject, html, text)
        return True
    except Exception as exc:  # noqa: BLE001 - 邮件失败不应冒泡成 500
        logger.error("[email] 发送失败 to=%s: %s", to, exc)
        return False


def build_code_email(code: str, purpose: str, site_url: str = "") -> Tuple[str, str, str]:
    """构造验证码邮件，返回 (subject, html, text)。"""
    label = PURPOSE_LABELS.get(purpose, "邮箱验证")
    ttl_minutes = max(1, settings.EMAIL_CODE_TTL_SECONDS // 60)
    site = site_url.rstrip("/") if site_url else "极客社区"

    subject = f"【极客社区】{label}验证码：{code}"
    text = (
        f"你正在进行{label}操作。\n\n"
        f"验证码：{code}\n"
        f"有效期：{ttl_minutes} 分钟。\n\n"
        f"如果这不是你本人的操作，请忽略本邮件，你的账号不会有任何变化。\n"
        f"—— {site}"
    )
    html = f"""\
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0b0c0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <div style="color:#f4f5f7;font-size:13px;letter-spacing:3px;text-transform:uppercase;opacity:.6;margin-bottom:24px;">GEEK COMMUNITY</div>
    <div style="background:#15181f;border:1px solid #262b36;border-radius:20px;padding:28px;">
      <h1 style="margin:0 0 12px;font-size:18px;color:#f4f5f7;">{label}</h1>
      <p style="margin:0 0 20px;font-size:13px;line-height:1.7;color:#9aa1ae;">
        你正在{label}，请在页面中输入下方验证码完成验证。
      </p>
      <div style="background:#0b0c0f;border:1px solid #2c3341;border-radius:14px;padding:18px;text-align:center;">
        <span style="font-size:30px;letter-spacing:10px;font-weight:700;color:#f4f5f7;font-family:ui-monospace,Menlo,Consolas,monospace;">{code}</span>
      </div>
      <p style="margin:18px 0 0;font-size:12px;color:#6f7684;">验证码 {ttl_minutes} 分钟内有效，仅可使用一次。</p>
      <p style="margin:8px 0 0;font-size:12px;color:#6f7684;">如果这不是你本人的操作，请忽略本邮件，账号不会有任何变化。</p>
    </div>
    <p style="margin:20px 0 0;font-size:11px;color:#5b6270;text-align:center;">{site}</p>
  </div>
</body>
</html>"""
    return subject, html, text


def build_email_changed_email(old_email: str, new_email: str) -> Tuple[str, str, str]:
    """换绑邮箱时给旧邮箱发送的安全提醒。"""
    subject = "【极客社区】你的账号绑定邮箱已变更"
    text = (
        f"你的账号绑定邮箱已从 {old_email} 变更为 {new_email}。\n\n"
        "如果这不是你本人的操作，请立即使用验证码重置密码并联系站点管理员。\n"
    )
    html = f"""\
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0b0c0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <div style="background:#15181f;border:1px solid #262b36;border-radius:20px;padding:28px;">
      <h1 style="margin:0 0 12px;font-size:18px;color:#f4f5f7;">绑定邮箱已变更</h1>
      <p style="margin:0;font-size:13px;line-height:1.7;color:#9aa1ae;">
        你的账号绑定邮箱已从 <b style="color:#f4f5f7;">{old_email}</b> 变更为
        <b style="color:#f4f5f7;">{new_email}</b>。<br><br>
        如果这不是你本人的操作，请立即使用验证码重置密码并联系站点管理员。
      </p>
    </div>
  </div>
</body></html>"""
    return subject, html, text


def build_password_changed_email(site_url: str = "") -> Tuple[str, str, str]:
    """密码变更成功通知邮件。"""
    site = site_url.rstrip("/") if site_url else "极客社区"
    subject = "【极客社区】你的登录密码已修改"
    text = (
        "你的账号登录密码刚刚被修改，此前签发的所有登录凭证均已失效。\n\n"
        "如果这不是你本人的操作，请立即通过邮箱验证码重置密码，并联系我们。\n"
        f"—— {site}"
    )
    html = f"""\
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0b0c0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <div style="background:#15181f;border:1px solid #262b36;border-radius:20px;padding:28px;">
      <h1 style="margin:0 0 12px;font-size:18px;color:#f4f5f7;">密码已修改</h1>
      <p style="margin:0;font-size:13px;line-height:1.7;color:#9aa1ae;">
        你的账号登录密码刚刚被修改，此前签发的所有登录凭证均已失效，需要重新登录。<br><br>
        如果这不是你本人的操作，请立即使用邮箱验证码重置密码，并联系站点管理员。
      </p>
    </div>
    <p style="margin:20px 0 0;font-size:11px;color:#5b6270;text-align:center;">{site}</p>
  </div>
</body></html>"""
    return subject, html, text

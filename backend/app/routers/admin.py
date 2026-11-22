import secrets
import uuid
import asyncio
from app.core.config import settings
from datetime import datetime, timezone, timedelta
from typing import List, Optional
import json
from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, delete, update, or_, func, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import selectinload
from app.core.database import get_db, get_redis
from app.core.security import verify_password, verify_password_async, get_password_hash_async
import logging
from app.core.timezone import utc_now
from app.models.system import Report, SiteAnnouncement, AdminAuditLog, SensitiveWord, Notification, SystemSetting
from app.models.comment import Comment
from app.models.post import Post, PostEdit, PostImage, Like, Collection, PostSeries, SeriesItem
from app.models.poll import Poll, PollOption, PollVote
from app.models.chat import Conversation, Message, GroupRoom, GroupMessage, GroupMember, GroupJoinRequest
from app.models.feedback import Feedback, FeedbackUpvote
from app.models.user import User, InviteCode, Follow, UserBlock, Checkin
from app.schemas.interaction import ReportCreateRequest
from app.schemas.user import UserAdminListItem, RoleUpdateRequest, StatusUpdateRequest, LevelUpdateRequest, DeleteUserRequest
from app.routers.deps import get_current_user, get_current_admin, get_current_moderator, get_current_super_admin, get_current_root_admin
from app.services.sensitive_service import sensitive_filter
from app.services.level_service import deduct_user_experience, set_user_level
from app.services.user_deletion import (
    STATUS_DELETING,
    purge_user_data,
    request_user_deletion,
    restore_user,
)

logger = logging.getLogger(__name__)

REPORT_REASON_LABELS = {
    "spam": "垃圾广告 / 推广营销",
    "attack": "人身攻击 / 恶意辱骂",
    "illegal": "违法违规内容",
    "privacy": "侵权 / 隐私泄露",
    "other": "其他违规事由",
}
REPORT_STATUS_LABELS = {"pending": "待处理", "resolved": "已处理", "rejected": "已驳回"}
VALID_REPORT_STATUSES = {"pending", "resolved", "rejected"}



router = APIRouter(prefix="/admin", tags=["社区治理与管理"])


def write_admin_audit(
    db: AsyncSession,
    admin: User,
    action: str,
    target_user_id: Optional[uuid.UUID],
    detail: str,
    request: Optional[Request] = None
):
    """记录管理端高危操作审计（角色变更/状态封禁/删号/配置修改）。

    复用 admin_audit_logs 表；action 前缀写入 reason，target_real_user_id 记录被操作者。
    """
    client_ip = "0.0.0.0"
    if request is not None and request.client:
        client_ip = request.client.host or "0.0.0.0"
    db.add(AdminAuditLog(
        admin_id=admin.id,
        target_comment_id=None,
        target_real_user_id=target_user_id or admin.id,
        reason=f"[{action}] {detail}"[:2000],
        ip_address=client_ip[:45]
    ))

# ---------- 前台用户举报 ----------
@router.post("/reports")
async def create_report(
    req: ReportCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    # 目标必须真实存在，避免脏数据污染审核队列
    if req.target_type == "post":
        exists = await db.scalar(select(Post.id).where(Post.id == req.target_id))
    else:
        exists = await db.scalar(select(Comment.id).where(Comment.id == req.target_id))
    if not exists:
        raise HTTPException(status_code=404, detail="举报对象不存在或已被删除")

    # 同一用户对同一目标的待处理举报只保留一条，避免刷爆审核队列
    duplicated = await db.scalar(
        select(Report.id).where(
            Report.reporter_id == user.id,
            Report.target_type == req.target_type,
            Report.target_id == req.target_id,
            Report.status == "pending",
        )
    )
    if duplicated:
        raise HTTPException(status_code=409, detail="你已提交过该内容的举报，管理员正在处理中")

    clean_desc = (req.description or "").strip()
    if len(clean_desc) < 10:
        raise HTTPException(status_code=400, detail="请填写至少 10 个字的详细举报原因")

    image_url = (req.image_url or "").strip() or None
    if image_url and not image_url.startswith("/uploads/"):
        raise HTTPException(status_code=400, detail="举报截图地址不合法")

    db.add(Report(
        reporter_id=user.id,
        target_type=req.target_type,
        target_id=req.target_id,
        reason_type=req.reason_type,
        description=clean_desc[:500],
        image_url=image_url,
    ))
    await db.commit()
    return {"message": "举报已提交，可在「我的举报」查看处理进度"}

# ---------- 管理员专属治理接口 ----------
@router.get("/reports/pending-count")
async def pending_report_count(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """页签角标用的真实待处理总数（不受分页影响）"""
    count = await db.scalar(select(func.count(Report.id)).where(Report.status == "pending"))
    return {"count": int(count or 0)}


@router.get("/reports")
async def list_reports(
    status: str = "pending",
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    if status not in VALID_REPORT_STATUSES:
        raise HTTPException(status_code=400, detail="无效的举报状态")
    query = (
        select(Report)
        .where(Report.status == status)
        .order_by(Report.created_at.desc(), Report.id.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = (await db.execute(query)).scalars().all()
    # 显式构造响应：不把 reporter_id / resolved_by 等内部字段原样返回给只读审计员
    reporter_ids = {r.reporter_id for r in rows}
    names = {}
    if reporter_ids:
        name_rows = (await db.execute(
            select(User.id, User.username).where(User.id.in_(reporter_ids))
        )).all()
        names = {rid: uname for rid, uname in name_rows}
    return [{
        "id": r.id,
        "target_type": r.target_type,
        "target_id": str(r.target_id),
        "reason_type": r.reason_type,
        "reason_label": REPORT_REASON_LABELS.get(r.reason_type, r.reason_type),
        "description": r.description or "",
        "image_url": getattr(r, "image_url", None),
        "status": r.status,
        "status_label": REPORT_STATUS_LABELS.get(r.status, r.status),
        "resolve_note": r.resolve_note or "",
        "created_at": r.created_at,
        "handled_at": getattr(r, "handled_at", None),
        "reporter_username": names.get(r.reporter_id, "已注销用户"),
    } for r in rows]

@router.get("/reports/{report_id}")
async def get_report_detail(
    report_id: int,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    r = (await db.execute(select(Report).where(Report.id == report_id))).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="举报记录不存在")
    return {
        "id": r.id,
        "target_type": r.target_type,
        "target_id": str(r.target_id),
        "reason_type": r.reason_type,
        "reason_label": REPORT_REASON_LABELS.get(r.reason_type, r.reason_type),
        "description": r.description or "",
        "image_url": getattr(r, "image_url", None),
        "status": r.status,
        "status_label": REPORT_STATUS_LABELS.get(r.status, r.status),
        "resolve_note": r.resolve_note or "",
        "created_at": r.created_at,
        "handled_at": getattr(r, "handled_at", None),
    }


@router.post("/reports/{report_id}/resolve")
async def resolve_report(
    report_id: int,
    action: str,  # block_target / reject
    request: Request,
    note: str = "",
    admin: User = Depends(get_current_moderator),
    db: AsyncSession = Depends(get_db)
):
    # action 白名单：未知取值一律拒绝，避免"传空/传错就默认放行"的模糊行为
    if action not in {"block_target", "reject"}:
        raise HTTPException(status_code=400, detail="无效的处置动作，仅支持 block_target / reject")

    q = select(Report).where(Report.id == report_id)
    report = (await db.execute(q)).scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=404, detail="举报记录不存在")

    # 幂等：已处置过的举报不允许重复处置（否则会重复扣经验、重复封禁）
    if report.status != "pending":
        return {"message": "该举报已处置完毕，无需重复操作", "status": report.status, "idempotent": True}

    if len(note or "") > 500:
        raise HTTPException(status_code=400, detail="处置备注过长 (最多 500 字)")

    target_author_id: Optional[uuid.UUID] = None
    target_desc = ""

    # 通知跳转用的目标 ID：评论举报必须指向所属帖子，否则抽屉点击会按帖子 ID 查评论 UUID 而 404
    notify_target_id = report.target_id

    if action == "block_target":
        # 先落状态再扣经验：deduct_user_experience 内部会 commit，
        # 若先扣分后置状态、最终提交失败，重试时会因幂等放行而重复删帖+重复扣 50 经验
        report.status = "resolved"
        report.resolved_by = admin.id
        report.resolve_note = note

        if report.target_type == "post":
            post_q = select(Post).where(Post.id == report.target_id)
            post = (await db.execute(post_q)).scalar_one_or_none()
            if post:
                post.status = "deleted"
                target_author_id = post.author_id
                target_desc = f"文章《{(post.title or '')[:20]}》"
                # 扣除作者 50 经验惩罚并重算等级（经验服务只 flush，随下方统一 commit 一并提交）
                author_q = select(User).where(User.id == post.author_id)
                author = (await db.execute(author_q)).scalar_one_or_none()
                if author:
                    await deduct_user_experience(author, 50, db, reason=f"违规文章《{post.title[:20]}》被管理下架封禁")
        elif report.target_type == "comment":
            c_q = select(Comment).where(Comment.id == report.target_id)
            comment = (await db.execute(c_q)).scalar_one_or_none()
            if comment:
                comment.status = "blocked"
                # 问答广场：回答被违规下架时扣回已发放的采纳奖励
                from app.services.qa_service import clawback_answer
                await clawback_answer(db, comment.id)
                target_author_id = comment.author_id
                target_desc = "评论"
                # 计数一致性：封禁评论同步扣减帖子评论计数（与 delete_comment 行为对齐）
                if comment.post_id:
                    await db.execute(
                        update(Post).where(Post.id == comment.post_id, Post.comment_count > 0)
                        .values(comment_count=Post.comment_count - 1)
                    )
                    notify_target_id = comment.post_id
        else:
            raise HTTPException(status_code=400, detail="不支持的举报目标类型")
    else:
        report.status = "rejected"
        report.resolved_by = admin.id
        report.resolve_note = note

    report.handled_at = utc_now()
    # Notification.brief 为 255，留足前缀空间后携带尽可能完整的处理理由
    note_brief = (note or "").strip()[:160] or "无"

    # 处置结果回执给被处置者，避免"内容消失但不知原因"
    if target_author_id and target_author_id != admin.id:
        db.add(Notification(
            receiver_id=target_author_id,
            sender_id=admin.id,
            action_type="system",
            target_id=notify_target_id,
            brief=f"你的{target_desc}经核实违反社区公约，已被下架处理。备注：{note_brief}"
        ))

    # 处置结果回执给举报人：此前后台点完处置，举报人永远收不到任何结论
    if report.reporter_id and report.reporter_id != admin.id:
        result_desc = "已核实违规并下架处理" if action == "block_target" else "经核实未发现违规，举报已驳回"
        db.add(Notification(
            receiver_id=report.reporter_id,
            sender_id=admin.id,
            action_type="system",
            # 指向被举报内容，点击可直达文章/评论；完整记录见「我的举报」
            target_id=notify_target_id,
            brief=f"你提交的举报（#{report.id}）已处理：{result_desc}。处理理由：{note_brief}"
        ))

    # reject 时 target_author_id 为空，用举报人作为审计对象，避免记成管理员自己
    write_admin_audit(db, admin, "resolve_report", target_author_id or report.reporter_id,
                      f"report#{report.id} action={action} note={note}", request)
    await db.commit()
    return {"message": "处置完毕", "status": report.status}

# ---------- 匿名身份穿透审计 (极其严谨，必须留痕) ----------
@router.get("/audit/comment/{comment_id}")
async def audit_anonymous_identity(
    comment_id: uuid.UUID,
    reason: str,
    request: Request,
    admin: User = Depends(get_current_super_admin),
    db: AsyncSession = Depends(get_db)
):
    """匿名身份穿透：仅管理员及以上可执行，且必须留痕、只返回审核所需的最小信息。

    版主/审核员（moderator/auditor）不具备该权限，避免只读角色批量去匿名化。
    """
    if not reason or len(reason.strip()) < 5:
        raise HTTPException(status_code=400, detail="解密匿名身份必须输入详实的审核理由 (不少于 5 字)")
    if len(reason) > 500:
        raise HTTPException(status_code=400, detail="审核理由过长 (最多 500 字)")

    q = select(Comment).options(selectinload(Comment.author)).where(Comment.id == comment_id)
    comment = (await db.execute(q)).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="评论不存在")

    client_ip = request.client.host if request.client else "0.0.0.0"

    # 写入审计操作记录
    log = AdminAuditLog(
        admin_id=admin.id,
        target_comment_id=comment.id,
        target_real_user_id=comment.author_id,
        reason=reason,
        ip_address=client_ip
    )
    db.add(log)
    await db.commit()

    # 只返回定位责任人所需的最小字段，不再下发邮箱等 PII
    return {
        "comment_id": comment.id,
        "is_anonymous": comment.is_anonymous,
        "anonymous_alias": comment.anonymous_alias,
        "real_author_id": comment.author.id,
        "real_username": comment.author.username,
        "status": comment.author.status,
        "audit_logged": True
    }

# ---------- 邀请码生成 ----------
@router.post("/invite-codes")
async def generate_invite_codes(
    count: int = 1,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    """生成邀请码 (v5 配额规则)。

    - super_admin: 无限量，30 天有效
    - admin / moderator: 每 72 小时 10 个，30 天有效
    - auditor 与普通用户不适用本端点（普通用户 Lv.3+ 走个人主页入口，72 小时时效）
    有效期由服务端按身份强制决定，不接受客户端传入。
    """
    from app.services.invite_service import generate_invite_codes as _gen
    if admin.role == "auditor":
        raise HTTPException(status_code=403, detail="只读审计员无邀请码生成资格")
    codes, expires, err = await _gen(db, admin, max(1, min(count, 50)))
    if err:
        raise HTTPException(status_code=400, detail=err)
    return {"codes": codes, "expires_at": expires}

from pydantic import BaseModel

class AnnouncementPayload(BaseModel):
    title: Optional[str] = ""
    content: Optional[str] = ""
    level: Optional[str] = "info" # info, update, warning
    is_active: Optional[bool] = True

# ---------- 全站公告横幅与跑马灯 ----------
@router.post("/announcements")
async def toggle_announcement(
    payload: Optional[AnnouncementPayload] = None,
    content: Optional[str] = None,
    title: Optional[str] = None,
    level: Optional[str] = None,
    is_active: Optional[bool] = None,
    request: Request = None,
    admin: User = Depends(get_current_moderator),
    db: AsyncSession = Depends(get_db)
):
    final_content = (payload.content if payload and payload.content else content) or ""
    final_title = (payload.title if payload and payload.title else title) or ""
    final_level = (payload.level if payload and payload.level else level) or "info"
    final_is_active = (payload.is_active if payload and payload.is_active is not None else is_active)
    if final_is_active is None:
        final_is_active = True

    if not final_content.strip() and not final_title.strip():
        raise HTTPException(status_code=400, detail="公告内容或标题不能为空")

    # level 白名单：此前任意字符串透传入库，超长直接 DB 500
    if final_level not in ("info", "update", "warning"):
        final_level = "info"

    ann = SiteAnnouncement(
        title=final_title.strip()[:200],
        content=final_content.strip(),
        level=final_level,
        is_active=final_is_active
    )
    db.add(ann)
    await db.commit()
    await db.refresh(ann)
    # 发布公告属高危运营操作，补审计留痕
    write_admin_audit(db, admin, "announcement_publish", admin.id,
                      f"发布全站公告 #{ann.id}: {(ann.title or ann.content)[:40]}", request)
    await db.commit()
    return {"message": "全站公告已发布", "id": ann.id, "title": ann.title, "content": ann.content, "level": ann.level, "is_active": ann.is_active}

@router.get("/announcements")
async def list_announcements(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    q = select(SiteAnnouncement).order_by(SiteAnnouncement.created_at.desc()).limit(50)
    res = await db.execute(q)
    return res.scalars().all()

@router.get("/announcements/active")
async def get_active_announcements(db: AsyncSession = Depends(get_db)):
    q = select(SiteAnnouncement).where(SiteAnnouncement.is_active == True).order_by(SiteAnnouncement.created_at.desc()).limit(15)
    res = await db.execute(q)
    return res.scalars().all()

@router.get("/announcements/history")
async def get_public_announcements_history(
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db)
):
    """公开获取全站历史公告与版本更新日志 (仅展示激活状态，已下线草稿不对外暴露)"""
    limit = max(1, min(limit, 50))
    offset = max(0, offset)
    q = select(SiteAnnouncement).where(SiteAnnouncement.is_active == True).order_by(SiteAnnouncement.created_at.desc()).offset(offset).limit(limit)
    res = await db.execute(q)
    return res.scalars().all()

@router.patch("/announcements/{ann_id}/toggle")
async def toggle_announcement_status(
    ann_id: int,
    request: Request = None,
    admin: User = Depends(get_current_moderator),
    db: AsyncSession = Depends(get_db)
):
    ann = (await db.execute(select(SiteAnnouncement).where(SiteAnnouncement.id == ann_id))).scalar_one_or_none()
    if not ann:
        raise HTTPException(status_code=404, detail="公告不存在")
    ann.is_active = not ann.is_active
    write_admin_audit(db, admin, "announcement_toggle", admin.id,
                      f"公告 #{ann.id} 状态切换为 {'激活' if ann.is_active else '下线'}", request)
    await db.commit()
    return {"message": "公告状态已更新", "is_active": ann.is_active}

@router.delete("/announcements/{ann_id}")
async def delete_announcement(
    ann_id: int,
    request: Request = None,
    admin: User = Depends(get_current_moderator),
    db: AsyncSession = Depends(get_db)
):
    ann = (await db.execute(select(SiteAnnouncement).where(SiteAnnouncement.id == ann_id))).scalar_one_or_none()
    if not ann:
        raise HTTPException(status_code=404, detail="公告不存在")
    write_admin_audit(db, admin, "announcement_delete", admin.id,
                      f"删除全站公告 #{ann.id}: {(ann.title or ann.content)[:40]}", request)
    await db.delete(ann)
    await db.commit()
    return {"message": "公告已成功删除"}

@router.get("/announcement/current")
async def get_active_announcement(db: AsyncSession = Depends(get_db)):
    q = select(SiteAnnouncement).where(SiteAnnouncement.is_active == True).order_by(SiteAnnouncement.created_at.desc())
    res = await db.execute(q)
    return res.scalars().first()

# ---------- 极客成员管理与角色任免 ----------
@router.get("/users", response_model=List[UserAdminListItem])
async def list_users(
    search: Optional[str] = None,
    role: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    query = select(User)
    if search:
        query = query.where(
            (User.username.ilike(f"%{search}%")) |
            (User.nickname.ilike(f"%{search}%")) |
            (User.email.ilike(f"%{search}%"))
        )

    if role:
        query = query.where(User.role == role)
    if status:
        query = query.where(User.status == status)
    query = query.order_by(User.created_at.desc()).offset(offset).limit(limit)
    res = await db.execute(query)
    users = res.scalars().all()

    # 邮箱属于个人隐私：管理后台默认脱敏，仅超级管理员本人可见完整地址。
    # 版主/审计员同样需要这份列表做治理，但没有必要看到用户邮箱。
    see_email = admin.role == "super_admin"
    return [
        {
            "id": u.id,
            "username": u.username,
            "nickname": u.nickname,
            "email": (u.email or "") if see_email else "***@***.com",
            "avatar_url": u.avatar_url,
            "role": u.role,
            "status": u.status,
            "level": u.level,
            "experience": u.experience,
            "active_days": u.active_days,
            "created_at": u.created_at,
            "last_login_at": u.last_login_at,
            "deletion_requested_at": u.deletion_requested_at,
            "status_before_deletion": u.status_before_deletion,
            "purge_after": u.purge_after,
        }
        for u in users
    ]

@router.put("/users/{user_id}/role")
async def update_user_role(
    user_id: uuid.UUID,
    req: RoleUpdateRequest,
    request: Request,
    super_admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db)
):
    q = select(User).where(User.id == user_id)
    target = (await db.execute(q)).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 禁止自己改自己的角色：既防自我提权，也防误操作把自己降级
    if target.id == super_admin.id:
        raise HTTPException(status_code=400, detail="不能修改自己的角色，如需变更请由另一位超级管理员操作")

    # 保护最后一位超级管理员，避免全站失去最高权限入口
    if target.role == "super_admin" and req.role != "super_admin":
        other_roots = (await db.execute(
            select(func.count(User.id)).where(
                User.role == "super_admin",
                User.id != target.id,
                User.status.not_in(("banned", "deactivated", "deleting"))
            )
        )).scalar() or 0
        if other_roots == 0:
            raise HTTPException(status_code=400, detail="系统必须保留至少一位超级管理员，无法降级当前唯一超管")

    old_role = target.role
    target.role = req.role
    write_admin_audit(db, super_admin, "role_change", target.id,
                      f"{target.username}: {old_role} -> {req.role}", request)
    await db.commit()
    return {"message": f"用户 {target.username} 角色已更新为 {target.role}", "role": target.role}

@router.put("/users/{user_id}/status")
async def update_user_status(
    user_id: uuid.UUID,
    req: StatusUpdateRequest,
    request: Request,
    admin: User = Depends(get_current_moderator),
    db: AsyncSession = Depends(get_db)
):
    q = select(User).where(User.id == user_id)
    target = (await db.execute(q)).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    if target.id == admin.id and req.status != "active":
        raise HTTPException(status_code=400, detail="不可降级或封禁当前管理员自身账号")

    # 管理账号的状态只允许超级管理员调整（版主/审核员不得处置管理员）
    if target.role in {"super_admin", "admin"}:
        if admin.role != "super_admin":
            raise HTTPException(status_code=403, detail="仅超级管理员可调整管理员账号的状态")
        if req.status != "active":
            raise HTTPException(status_code=403, detail="不可降级或封禁最高管理员/系统管理员账号")

    old_status = target.status
    target.status = req.status
    if req.status == "banned":
        # 封禁即吊销：自增令牌版本，使该用户已登录的会话与刷新令牌全部失效
        target.token_version = (target.token_version or 0) + 1

    # 若由见习期转正为正式会员，自动核算升级并下发通知
    if old_status == "probation" and req.status == "active":
        if target.level == 0:
            from app.services.level_service import calculate_level_from_exp
            calc_lvl = calculate_level_from_exp(target.experience)
            target.level = max(1, calc_lvl)
            if target.experience < 1:
                target.experience = 1

        notif = Notification(
            receiver_id=target.id,
            sender_id=admin.id,
            action_type="system",
            
            brief="恭喜！管理员已为你提前通过见习期考核，已晋升为正式极客会员，发帖与全站权限已解锁！"
        )
        db.add(notif)
    elif req.status == "banned":
        notif = Notification(
            receiver_id=target.id,
            sender_id=admin.id,
            action_type="system",
            
            brief="系统提醒：因违反社区公约，你的账号已被管理员执行封禁。"
        )
        db.add(notif)

    write_admin_audit(db, admin, "status_change", target.id,
                      f"{target.username}: {old_status} -> {req.status}", request)
    await db.commit()
    return {"message": f"用户 {target.username} 账号状态已调整为 {target.status}", "status": target.status}

# ---------- 极客成员等级设置 ----------
@router.put("/users/{user_id}/level")
async def update_user_level(
    user_id: uuid.UUID,
    req: LevelUpdateRequest,
    request: Request,
    admin: User = Depends(get_current_moderator),
    db: AsyncSession = Depends(get_db)
):
    q = select(User).where(User.id == user_id)
    target = (await db.execute(q)).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    # 管理账号的等级只允许超级管理员调整，避免低权角色削弱管理员配额
    if target.role in {"super_admin", "admin"} and admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="只有超级管理员可以调整管理员的等级")

    old_level = target.level
    await set_user_level(target, req.level, db, experience=req.experience)
    write_admin_audit(db, admin, "level_change", target.id,
                      f"{target.username}: Lv.{old_level} -> Lv.{req.level}", request)
    # 经验服务只 flush，这里统一提交，确保等级变更与审计日志同事务落库
    await db.commit()
    return {
        "message": f"用户 {target.username} 等级已调整为 Lv.{target.level}（当前经验：{target.experience} EXP）",
        "level": target.level,
        "experience": target.experience
    }

# ---------- 社区全局运行规则与经验配置 ----------
@router.get("/settings")
async def get_system_settings(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    q = select(SystemSetting).order_by(SystemSetting.key.asc())
    res = await db.execute(q)
    return res.scalars().all()

@router.put("/settings")
async def update_system_settings(
    payload: dict[str, str],
    request: Request,
    super_admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db)
):
    """
    配置社区核心规则与经验上限（仅限超级管理员）
    支持: daily_post_limit, daily_exp_limit, post_exp_reward 等
    """
    allowed_keys = {"daily_post_limit", "daily_exp_limit", "post_exp_reward", "checkin_times_per_day"}
    for k, v in payload.items():
        if k in allowed_keys:
            try:
                int_v = int(v)
                if int_v < 0:
                    raise HTTPException(status_code=400, detail=f"配置项 {k} 的数值不能小于 0")
            except ValueError:
                raise HTTPException(status_code=400, detail=f"配置项 {k} 必须为有效整数")

            q = select(SystemSetting).where(SystemSetting.key == k)
            st = (await db.execute(q)).scalar_one_or_none()
            if st:
                st.value = str(v)
                st.updated_at = utc_now()
            else:
                db.add(SystemSetting(key=k, value=str(v)))

    write_admin_audit(db, super_admin, "update_settings", None,
                      f"配置变更: {payload}", request)
    await db.commit()
    return {"message": "社区规则与经验限制配置已成功更新！"}

# ---------- 对象存储 (Cloudflare R2 / S3) 状态诊断与测试 ----------
@router.get("/storage/status")
async def get_storage_status(
    root_admin: User = Depends(get_current_root_admin)
):
    """查询当前系统的存储引擎状态 (保护安全，隐藏秘钥值)"""
    return {
        "storage_type": settings.STORAGE_TYPE or "local",
        # 对象存储总开关：当前停用时上传只落本地磁盘
        "s3_enabled": bool(settings.S3_ENABLED),
        "is_s3": (settings.STORAGE_TYPE or "").lower() == "s3",
        "s3_endpoint": settings.S3_ENDPOINT,
        "s3_bucket": settings.S3_BUCKET,
        "s3_public_domain": settings.S3_PUBLIC_DOMAIN,
        "s3_region": settings.S3_REGION or "auto",
        "has_access_key": bool(settings.S3_ACCESS_KEY),
        "has_secret_key": bool(settings.S3_SECRET_KEY),
    }

@router.post("/storage/test")
async def test_storage_connection(
    root_admin: User = Depends(get_current_root_admin)
):
    """一键诊断测试当前 Cloudflare R2 / S3 对象存储配置连通性"""
    from app.services.image_service import test_s3_connection
    res = await asyncio.to_thread(test_s3_connection)
    return res

# ---------- 彻底清空并注销用户（最高管理员专属） ----------
@router.delete("/users/{target_user_id}")
async def delete_user_and_all_data(
    target_user_id: uuid.UUID,
    request: Request,
    purge: bool = Query(False, description="true=跳过缓冲期立即彻底清除（不可恢复）"),
    req: Optional[DeleteUserRequest] = None,
    super_admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db)
):
    """删除用户。

    默认行为：置入 10 天注销缓冲期 —— 账号对其他人不可见、内容全部隐藏，
    但数据完整保留，超级管理员可随时一键恢复。

    传 ?purge=true 则跳过缓冲期，立刻彻底清除（不可逆，仅应急使用）。
    """
    # 不可逆操作必须二次校验当前操作者密码，避免会话被劫持后一键毁库
    if not req or not req.password:
        raise HTTPException(status_code=400, detail="该操作不可逆，请输入当前账号的登录密码以确认")
    if not await verify_password_async(req.password, super_admin.password_hash):
        raise HTTPException(status_code=400, detail="密码校验失败，删除操作已终止")

    target = (await db.execute(select(User).where(User.id == target_user_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="目标用户不存在或已被删除")

    if target.id == super_admin.id:
        raise HTTPException(status_code=400, detail="不可删除当前管理员自身的账号")

    if target.role in {"super_admin", "admin"}:
        raise HTTPException(status_code=403, detail="安全保护机制生效：不可直接删除超级管理员或系统管理员账号")

    if purge:
        write_admin_audit(db, super_admin, "delete_user", target.id,
                          f"彻底清空并注销 @{target.username}", request)
        username_backup = await purge_user_data(db, target)
        return {
            "success": True,
            "purged": True,
            "message": f"用户 @{username_backup} 及其所有历史数据已彻底清空并永久注销！"
        }

    if target.status == STATUS_DELETING:
        raise HTTPException(
            status_code=400,
            detail="该账号已在注销缓冲期内，可在用户列表筛选「待删除」后选择恢复或立即清除"
        )

    purge_after = await request_user_deletion(db, target)
    write_admin_audit(db, super_admin, "delete_user", target.id,
                      f"置入注销缓冲期 @{target.username}，预计 {purge_after:%Y-%m-%d} 清除", request)
    await db.commit()
    return {
        "success": True,
        "purged": False,
        "purge_after": purge_after.isoformat(),
        "grace_days": settings.DELETION_GRACE_DAYS,
        "message": f"用户 @{target.username} 已进入注销缓冲期，{purge_after:%Y-%m-%d %H:%M} 前可恢复"
    }


@router.post("/users/{target_user_id}/restore")
async def restore_deleted_user(
    target_user_id: uuid.UUID,
    request: Request,
    super_admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db)
):
    """超级管理员一键恢复：还原账号状态、内容可见性与绑定关系。"""
    target = (await db.execute(select(User).where(User.id == target_user_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="目标用户不存在")
    if target.status not in (STATUS_DELETING, "deactivated"):
        raise HTTPException(status_code=400, detail="该账号不在注销状态，无需恢复")

    await restore_user(db, target)
    write_admin_audit(db, super_admin, "restore_user", target.id, f"恢复账号 @{target.username}", request)
    await db.commit()
    return {"success": True, "message": f"用户 @{target.username} 已恢复，其内容重新可见"}


class ReviewResolvePayload(BaseModel):
    status: str = Field("resolved", pattern=r"^(resolved|dismissed)$")


@router.get("/sensitive-reviews")
async def list_sensitive_reviews(
    status: str = "pending",
    admin: User = Depends(get_current_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """敏感词打回待审队列（仅超级管理员）。"""
    rows = (await db.execute(text(
        "SELECT q.id, q.post_id, q.author_id, q.title, q.hits, q.status, q.created_at, "
        "u.username AS author_username FROM sensitive_review_queue q "
        "LEFT JOIN users u ON u.id = q.author_id WHERE q.status = :s "
        "ORDER BY q.created_at DESC LIMIT 100"
    ), {"s": status})).mappings().all()
    return [dict(r) for r in rows]


@router.post("/sensitive-reviews/{review_id}/resolve")
async def resolve_sensitive_review(
    review_id: int,
    payload: ReviewResolvePayload,
    admin: User = Depends(get_current_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """标记待审记录已处理 / 判定为误伤（不自动放行文章，作者需修改后重新发布）。"""
    await db.execute(text(
        "UPDATE sensitive_review_queue SET status = :s, resolved_by = :u, resolved_at = now() "
        "WHERE id = :i"
    ), {"s": payload.status, "u": str(admin.id), "i": review_id})
    await db.commit()
    return {"ok": True}


# 超管重置用户口令后使用的统一初始口令
# 管理员重置后额外发放的昵称修改额度上限：避免反复点重置刷出无限次修改
NICKNAME_EXTRA_QUOTA_CAP = 3


def _grant_extra_nickname_change(target: User, amount: int = 1) -> int:
    """用户管理页执行重置后，给被重置者补 1 次昵称修改机会。

    只由本模块的重置接口调用，因此「额外修改机会」只会在管理员操作后发放，
    用户自己的资料页无法触发。
    """
    current = max(0, int(getattr(target, "nickname_extra_quota", 0) or 0))
    target.nickname_extra_quota = min(NICKNAME_EXTRA_QUOTA_CAP, current + amount)
    return target.nickname_extra_quota


def _assert_profile_reset_allowed(admin: User, target: User) -> None:
    """资料重置的越权防护：不能重置自己，普通管理员不能动管理团队账号。"""
    if target.id == admin.id:
        raise HTTPException(status_code=400, detail="不能重置自己的资料，请在个人中心修改")
    if target.role in ("super_admin", "admin") and admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="普通管理员不能重置管理团队成员的资料")


@router.post("/users/{user_id}/reset-password")
async def reset_user_password(
    user_id: uuid.UUID,
    request: Request,
    super_admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
):
    """仅超级管理员：把用户口令重置为固定初始口令。

    重置后 must_change_password=True，后端会拒绝其它业务接口，
    用户下次登录必须改密；token_version +1 让已有会话立即失效。
    """
    target = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    if target.id == super_admin.id:
        raise HTTPException(status_code=400, detail="不能重置自己的口令，请使用修改密码")
    if getattr(target, "status_before_deletion", None):
        raise HTTPException(status_code=400, detail="注销缓冲期账号不可重置口令")

    temp_password = f"Lt-{secrets.token_urlsafe(6)}"
    target.password_hash = await get_password_hash_async(temp_password)
    target.must_change_password = True
    target.token_version = (target.token_version or 0) + 1
    _grant_extra_nickname_change(target)
    write_admin_audit(db, super_admin, "reset_password", target.id,
                      f"重置 @{target.username} 的口令为初始口令", request)
    await db.commit()

    return {"ok": True, "username": target.username, "must_change_password": True, "temp_password": temp_password}


@router.post("/users/{user_id}/reset-avatar")
async def reset_user_avatar(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(get_current_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """管理员 / 超级管理员：清空用户头像，恢复系统默认徽章。

    仅用户管理页可用（接口挂在 /admin/users 下，且需要管理员身份）。
    """
    target = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    _assert_profile_reset_allowed(admin, target)

    target.avatar_url = None
    extra = _grant_extra_nickname_change(target)
    write_admin_audit(db, admin, "reset_avatar", target.id,
                      f"重置 @{target.username} 的头像（额外昵称额度 {extra}）", request)
    await db.commit()
    return {"ok": True, "username": target.username, "avatar_url": None, "nickname_extra_quota": extra}


@router.post("/users/{user_id}/reset-nickname")
async def reset_user_nickname(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(get_current_super_admin),
    db: AsyncSession = Depends(get_db),
):
    """管理员 / 超级管理员：把用户昵称恢复为默认（即用户名）。

    重置本身不消耗用户当月的 3 次额度，并额外补 1 次修改机会，
    这样即使额度已用完，用户也能重新起一个昵称。
    """
    target = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")
    _assert_profile_reset_allowed(admin, target)

    target.nickname = None
    extra = _grant_extra_nickname_change(target)
    write_admin_audit(db, admin, "reset_nickname", target.id,
                      f"重置 @{target.username} 的昵称为默认，额外昵称额度 {extra}", request)
    await db.commit()
    return {"ok": True, "username": target.username, "nickname": None, "nickname_extra_quota": extra}

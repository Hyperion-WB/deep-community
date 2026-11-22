from typing import Optional, List
from uuid import UUID
from datetime import date, datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func, delete, or_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.timezone import utc_now
from app.models.feedback import Feedback, FeedbackUpvote, FeedbackCategory
from app.models.system import Notification
from app.models.user import User
from app.schemas.feedback import FeedbackCreateRequest, FeedbackStatusUpdateRequest, FeedbackResponse, FeedbackConfirmRequest, FeedbackDraftRequest
from app.routers.deps import get_current_user, get_current_user_optional, get_current_moderator, is_admin_role
from app.services.level_service import add_user_experience, record_user_activity
from app.services.sensitive_service import sensitive_filter

FEEDBACK_IMAGE_LIMIT = 5


def _feedback_images(*values) -> list:
    """合并单图/多图字段，校验站内路径、去重并限制最多 5 张。"""
    out: list = []
    for v in values:
        if v is None:
            continue
        items = v if isinstance(v, (list, tuple)) else [v]
        for it in items:
            u = str(it).strip()
            if not u:
                continue
            if not u.startswith("/uploads/"):
                raise HTTPException(status_code=400, detail="图片地址不合法，请重新上传")
            if u not in out:
                out.append(u)
    if len(out) > FEEDBACK_IMAGE_LIMIT:
        raise HTTPException(status_code=400, detail=f"最多只能上传 {FEEDBACK_IMAGE_LIMIT} 张截图")
    return out


def _response_images(fb) -> list:
    imgs = getattr(fb, "image_urls", None)
    if isinstance(imgs, (list, tuple)) and imgs:
        return [str(u) for u in imgs[:FEEDBACK_IMAGE_LIMIT]]
    return [fb.image_url] if fb.image_url else []



router = APIRouter(prefix="/feedbacks", tags=["谏言堂与反馈中心"])

VALID_BUG_STATUSES = {"open", "investigating", "fixed", "wontfix", "completed"}
VALID_FEATURE_STATUSES = {"pending", "under_consideration", "accepted", "completed", "declined"}

# 通知文案用的中文状态名（与前端 BUG_STATUS_MAP / FEATURE_STATUS_MAP 保持一致）
BUG_STATUS_LABELS = {
    "open": "待排查",
    "investigating": "排查中",
    "fixed": "已修复",
    "wontfix": "暂不修复",
    "completed": "已完成",
}
FEATURE_STATUS_LABELS = {
    "pending": "待评估",
    "under_consideration": "评估中",
    "accepted": "已采纳",
    "completed": "已上线",
    "declined": "暂不考虑",
}

@router.post("", response_model=FeedbackResponse)
async def create_feedback(
    req: FeedbackCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """用户提交 Bug 反馈或功能建议"""
    # 敏感词扫描
    is_blocked, hit_words, clean_title = sensitive_filter.scan(req.title)
    if is_blocked:
        raise HTTPException(status_code=400, detail=f"标题包含违规内容: {', '.join(hit_words)}")

    is_blocked_c, hit_words_c, clean_content = sensitive_filter.scan(req.content)
    if is_blocked_c:
        raise HTTPException(status_code=400, detail=f"详细描述包含违规内容: {', '.join(hit_words_c)}")

    initial_status = "open" if req.feedback_type == "bug" else "pending"

    # 截图只允许站内上传地址，避免外链或脚本注入
    images = _feedback_images(req.image_url, getattr(req, "image_urls", None))
    image_url = images[0] if images else None

    new_fb = Feedback(
        user_id=user.id,
        feedback_type=req.feedback_type,
        title=clean_title,
        content=clean_content,
        status=initial_status,
        image_url=image_url,
        image_urls=images or None,
        category=(req.category or "other").strip()[:32] or "other",
        is_draft=bool(req.is_draft),
        upvotes_count=0 if req.is_draft else 1,
    )
    db.add(new_fb)
    await db.flush()

    # 草稿不产生点赞记录、不发经验；正式发布才计 1 票
    if not req.is_draft:
        db.add(FeedbackUpvote(feedback_id=new_fb.id, user_id=user.id))
        await add_user_experience(user, 5, db)
        await record_user_activity(user, db)

    await db.commit()
    await db.refresh(new_fb)

    return FeedbackResponse(
        id=new_fb.id,
        feedback_type=new_fb.feedback_type,
        title=new_fb.title,
        content=new_fb.content,
        status=new_fb.status,
        upvotes_count=new_fb.upvotes_count,
        has_upvoted=True,
        admin_reply=None,
        admin_replied_by_username=None,
        admin_replied_by_nickname=None,
        admin_replied_at=None,
        image_url=new_fb.image_url,
        image_urls=_response_images(new_fb),
        user_confirm="",
        user_confirm_at=None,
        user_note=None,
        can_confirm=False,
        author_id=user.id,
        author_username=user.username,
        author_nickname=user.nickname,
        author_avatar=user.avatar_url,
        author_level=user.level,
        created_at=new_fb.created_at,
        updated_at=new_fb.updated_at,
        category=new_fb.category or "other",
        is_draft=bool(new_fb.is_draft),
        withdrawn_at=new_fb.withdrawn_at,
    )

@router.get("/categories")
async def list_feedback_categories(db: AsyncSession = Depends(get_db)):
    """数据驱动的子分区：新增分区只需往 feedback_categories 插一行，不用改前端枚举。"""
    rows = (await db.execute(
        select(FeedbackCategory).where(FeedbackCategory.active.is_(True))
        .order_by(FeedbackCategory.parent_type, FeedbackCategory.sort, FeedbackCategory.id)
    )).scalars().all()
    grouped: dict = {"feature": [], "bug": []}
    for r in rows:
        grouped.setdefault(r.parent_type, []).append(r.name)
    return grouped


@router.get("", response_model=List[FeedbackResponse])
async def list_feedbacks(
    feedback_type: Optional[str] = Query(None, pattern="^(bug|feature|all)$"),
    status: Optional[str] = None,
    sort_by: str = Query("hot", pattern="^(hot|latest)$"),
    q: Optional[str] = Query(None, max_length=100),
    category: Optional[str] = Query(None, max_length=32),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    date_on: Optional[date] = Query(None),
    box: str = Query("all", pattern="^(all|draft|sent|withdrawn)$"),
    page: int = Query(1, ge=1),
    size: int = Query(30, ge=1, le=100),
    user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    """公开查询反馈列表 (支持热度排序、分类与状态筛选)"""
    query = select(Feedback).options(selectinload(Feedback.user), selectinload(Feedback.admin))

    if feedback_type and feedback_type != "all":
        query = query.where(Feedback.feedback_type == feedback_type)

    if status and status != "all":
        if status == "unresolved":
            # 「未完成」：还没有任何终态结论的反馈（待处理/排查中/待评估/考虑中/已采纳）。
            # 提新反馈前查重只需要看这一档，避免和管理员已结案的旧帖重复。
            query = query.where(
                Feedback.status.notin_(("fixed", "completed", "wontfix", "declined"))
            )
        else:
            query = query.where(Feedback.status == status)

    if category and category != "all":
        query = query.where(Feedback.category == category)

    # 按提交日期定位：单日选择优先（date_on 等价于起止同日）
    if date_on:
        query = query.where(func.date(Feedback.created_at) == date_on)
    if date_from:
        query = query.where(func.date(Feedback.created_at) >= date_from)
    if date_to:
        query = query.where(func.date(Feedback.created_at) <= date_to)

    # 公开列表排除草稿与已撤回；草稿箱三个分区只看本人
    if box == "all":
        query = query.where(Feedback.is_draft.is_(False), Feedback.withdrawn_at.is_(None))
    else:
        if user is None:
            raise HTTPException(status_code=401, detail="请先登录后查看草稿箱")
        query = query.where(Feedback.user_id == user.id)
        if box == "draft":
            query = query.where(Feedback.is_draft.is_(True))
        elif box == "sent":
            query = query.where(Feedback.is_draft.is_(False), Feedback.withdrawn_at.is_(None))
        else:
            query = query.where(Feedback.withdrawn_at.is_not(None))

    # 关键词检索：此前只在前端对已加载的 30 条做过滤，更早的反馈永远搜不到
    if q and q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        keyword = f"%{escaped}%"
        query = query.where(or_(
            Feedback.title.ilike(keyword, escape="\\"),
            Feedback.content.ilike(keyword, escape="\\"),
            Feedback.admin_reply.ilike(keyword, escape="\\"),
        ))

    if sort_by == "hot":
        query = query.order_by(Feedback.upvotes_count.desc(), Feedback.created_at.desc())
    else:
        query = query.order_by(Feedback.created_at.desc())

    query = query.offset((page - 1) * size).limit(size)
    res = await db.execute(query)
    feedbacks = res.scalars().all()

    # 查询当前用户点赞集合
    user_upvoted_ids = set()
    if user and feedbacks:
        fb_ids = [f.id for f in feedbacks]
        up_q = select(FeedbackUpvote.feedback_id).where(
            FeedbackUpvote.user_id == user.id,
            FeedbackUpvote.feedback_id.in_(fb_ids)
        )
        up_res = await db.execute(up_q)
        user_upvoted_ids = set(up_res.scalars().all())

    result = []
    for f in feedbacks:
        result.append(FeedbackResponse(
            id=f.id,
            feedback_type=f.feedback_type,
            title=f.title,
            content=f.content,
            status=f.status,
            upvotes_count=f.upvotes_count,
            has_upvoted=(f.id in user_upvoted_ids),
            admin_reply=f.admin_reply,
            admin_replied_by_username=f.admin.username if f.admin else None,
            admin_replied_by_nickname=f.admin.nickname if f.admin else None,
            admin_replied_at=f.admin_replied_at,
            image_url=f.image_url,
            image_urls=_response_images(f),
            user_confirm=f.user_confirm or "",
            user_confirm_at=f.user_confirm_at,
            user_note=f.user_note,
            can_confirm=bool(
                user
                and f.user_id == user.id
                and f.admin_replied_at is not None
                and not (f.user_confirm or "")
            ),
            author_id=f.user_id,
            author_username=f.user.username if f.user else "用户已注销",
            author_nickname=f.user.nickname if f.user else None,
            author_avatar=f.user.avatar_url if f.user else "",
            author_level=f.user.level if f.user else 1,
            created_at=f.created_at,
            updated_at=f.updated_at,
            category=getattr(f, "category", None) or "other",
            is_draft=bool(getattr(f, "is_draft", False)),
            withdrawn_at=getattr(f, "withdrawn_at", None),
        ))

    return result

@router.post("/{feedback_id}/upvote")
async def toggle_upvote_feedback(
    feedback_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """一键 UP 顶上去 / 取消 UP"""
    fb_q = select(Feedback).where(Feedback.id == feedback_id)
    fb = (await db.execute(fb_q)).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")

    exist_q = select(FeedbackUpvote).where(
        FeedbackUpvote.feedback_id == feedback_id,
        FeedbackUpvote.user_id == user.id
    )
    exist_up = (await db.execute(exist_q)).scalar_one_or_none()

    if exist_up:
        # 取消 UP
        await db.execute(delete(FeedbackUpvote).where(FeedbackUpvote.id == exist_up.id))
        await db.execute(update(Feedback).where(Feedback.id == feedback_id).values(
            upvotes_count=func.greatest(Feedback.upvotes_count - 1, 0)))
        has_upvoted = False
    else:
        # 新增 UP（并发双击时唯一约束兜底，避免未处理 IntegrityError 直接 500）
        new_up = FeedbackUpvote(feedback_id=feedback_id, user_id=user.id)
        db.add(new_up)
        await db.execute(update(Feedback).where(Feedback.id == feedback_id).values(
            upvotes_count=Feedback.upvotes_count + 1))
        has_upvoted = True

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # 并发重复插入：该用户实际已 UP，按取消前的真实状态返回
        total = (await db.execute(
            select(func.count()).select_from(FeedbackUpvote).where(FeedbackUpvote.feedback_id == feedback_id)
        )).scalar_one()
        refreshed = (await db.execute(fb_q)).scalar_one()
        return {
            "has_upvoted": True,
            "upvotes_count": refreshed.upvotes_count,
            "message": "你已顶过这条反馈"
        }
    real_count = (await db.execute(
        select(Feedback.upvotes_count).where(Feedback.id == feedback_id)
    )).scalar_one() or 0
    return {
        "has_upvoted": has_upvoted,
        "upvotes_count": real_count,
        "message": "已顶上去 (+1 UP)" if has_upvoted else "已取消 UP"
    }

@router.put("/{feedback_id}/status", response_model=FeedbackResponse)
async def update_feedback_status(
    feedback_id: UUID,
    req: FeedbackStatusUpdateRequest,
    admin: User = Depends(get_current_moderator),
    db: AsyncSession = Depends(get_db)
):
    """高级管理员专属：更新反馈状态与附带说明理由 (已采纳、暂不考虑、已修复等)"""
    query = select(Feedback).options(selectinload(Feedback.user), selectinload(Feedback.admin)).where(Feedback.id == feedback_id)
    fb = (await db.execute(query)).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")

    # 状态有效性验证
    valid_set = VALID_BUG_STATUSES if fb.feedback_type == "bug" else VALID_FEATURE_STATUSES
    if req.status not in valid_set:
        raise HTTPException(status_code=400, detail=f"无效的状态值: {req.status}")

    old_status = fb.status
    old_reply = (fb.admin_reply or "").strip()
    fb.status = req.status
    if req.admin_reply is not None:
        fb.admin_reply = req.admin_reply.strip()
    fb.admin_replied_by = admin.id
    fb.admin_replied_at = datetime.now(timezone.utc)
    fb.updated_at = datetime.now(timezone.utc)

    # 多轮闭环：管理员再次给出结论（状态或说明有变化）时，重置用户的确认状态，
    # 让「用户说还复现 → 我又修了一版 → 用户再确认」能继续走下去。
    # 同一轮内重复保存同一份回复不会重置，避免手滑点两下把用户确认清掉。
    reply_changed = (fb.admin_reply or "").strip() != old_reply
    status_changed = fb.status != old_status
    if (reply_changed or status_changed) and (fb.user_confirm or ""):
        fb.user_confirm = ""
        fb.user_confirm_at = None
        # user_note 保留：管理员能看到上一轮用户补了什么，作为排查线索

    # 进度/结论回执：此前状态变化对作者完全静默，只能靠自己回列表碰运气发现
    if fb.user_id != admin.id and (fb.status != old_status or req.admin_reply is not None):
        labels = BUG_STATUS_LABELS if fb.feedback_type == "bug" else FEATURE_STATUS_LABELS
        kind = "Bug 反馈" if fb.feedback_type == "bug" else "功能建议"
        brief = f"你的{kind}《{(fb.title or '')[:24]}》进度更新为「{labels.get(fb.status, fb.status)}」"
        if fb.admin_reply:
            brief += f"：{fb.admin_reply[:40]}"
        db.add(Notification(
            receiver_id=fb.user_id,
            sender_id=admin.id,
            action_type="system",
            # 指向作者本人，通知抽屉统一跳个人主页
            target_id=fb.user_id,
            brief=brief[:255],
        ))

    await db.commit()
    await db.refresh(fb)

    # 真实回填管理员本人的 UP 状态：此前硬编码 False，前端整体替换列表项后
    # 已 UP 状态被错误重置，再点一次会重复 +1
    admin_upvoted = bool((await db.execute(
        select(FeedbackUpvote.id).where(
            FeedbackUpvote.feedback_id == feedback_id, FeedbackUpvote.user_id == admin.id
        )
    )).scalar_one_or_none())

    return FeedbackResponse(
        id=fb.id,
        feedback_type=fb.feedback_type,
        title=fb.title,
        content=fb.content,
        status=fb.status,
        upvotes_count=fb.upvotes_count,
        has_upvoted=admin_upvoted,
        admin_reply=fb.admin_reply,
        admin_replied_by_username=admin.username,
        admin_replied_by_nickname=admin.nickname,
        admin_replied_at=fb.admin_replied_at,
        image_url=fb.image_url,
        image_urls=_response_images(fb),
        user_confirm=fb.user_confirm or "",
        user_confirm_at=fb.user_confirm_at,
        user_note=fb.user_note,
        can_confirm=False,
        author_id=fb.user_id,
        author_username=fb.user.username if fb.user else "用户已注销",
        author_nickname=fb.user.nickname if fb.user else None,
        author_avatar=fb.user.avatar_url if fb.user else "",
        author_level=fb.user.level if fb.user else 1,
        created_at=fb.created_at,
        updated_at=fb.updated_at
    )

@router.put("/{feedback_id}/confirm", response_model=FeedbackResponse)
async def confirm_feedback(
    feedback_id: UUID,
    req: FeedbackConfirmRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """反馈者确认处理结果。

    - Bug：已修复 / 仍可复现（仍可复现会把状态打回待排查，方便重新跟进）
    - 建议：已收到
    """
    fb = (await db.execute(
        select(Feedback)
        .options(selectinload(Feedback.user), selectinload(Feedback.admin))
        .where(Feedback.id == feedback_id)
    )).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")
    if fb.user_id != user.id:
        raise HTTPException(status_code=403, detail="只有反馈提交者可以确认")
    if not fb.admin_replied_at:
        raise HTTPException(status_code=400, detail="管理员还没有回复，暂时无法确认")
    if fb.user_confirm:
        raise HTTPException(status_code=400, detail="你已经确认过了")

    allowed = {"bug": {"fixed", "unfixed"}, "feature": {"received"}}
    if req.confirm not in allowed.get(fb.feedback_type, set()):
        raise HTTPException(status_code=400, detail="确认类型与反馈类型不匹配")

    fb.user_confirm = req.confirm
    fb.user_confirm_at = datetime.now(timezone.utc)

    note = (req.note or "").strip()
    if note:
        blocked, hits, clean_note = sensitive_filter.scan(note)
        if blocked:
            raise HTTPException(status_code=400, detail=f"补充说明包含违规内容: {', '.join(hits)}")
        fb.user_note = clean_note

    # Bug 仍能复现：打回待排查，让管理员重新看到
    if req.confirm == "unfixed":
        fb.status = "open"

    await db.commit()
    await db.refresh(fb)

    admin = fb.admin
    return FeedbackResponse(
        id=fb.id,
        feedback_type=fb.feedback_type,
        title=fb.title,
        content=fb.content,
        status=fb.status,
        upvotes_count=fb.upvotes_count,
        has_upvoted=True,
        admin_reply=fb.admin_reply,
        admin_replied_by_username=admin.username if admin else None,
        admin_replied_by_nickname=admin.nickname if admin else None,
        admin_replied_at=fb.admin_replied_at,
        image_url=fb.image_url,
        image_urls=_response_images(fb),
        user_confirm=fb.user_confirm or "",
        user_confirm_at=fb.user_confirm_at,
        user_note=fb.user_note,
        can_confirm=False,
        author_id=fb.user_id,
        author_username=fb.user.username if fb.user else "用户已注销",
        author_nickname=fb.user.nickname if fb.user else None,
        author_avatar=fb.user.avatar_url if fb.user else "",
        author_level=fb.user.level if fb.user else 1,
        created_at=fb.created_at,
        updated_at=fb.updated_at,
    )


@router.delete("/{feedback_id}")
async def delete_feedback(
    feedback_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """作者本人或管理员可删除反馈"""
    query = select(Feedback).where(Feedback.id == feedback_id)
    fb = (await db.execute(query)).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")

    if fb.user_id != user.id and not is_admin_role(user.role):
        raise HTTPException(status_code=403, detail="无权删除该条反馈")

    await db.execute(delete(Feedback).where(Feedback.id == feedback_id))
    await db.commit()
    return {"success": True, "message": "反馈已删除"}


@router.put("/{feedback_id}/draft", response_model=FeedbackResponse)
async def update_feedback_draft(
    feedback_id: UUID,
    req: FeedbackDraftRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """编辑自己的草稿或已撤回反馈（撤回后修改再发）。"""
    fb = (await db.execute(
        select(Feedback).where(Feedback.id == feedback_id, Feedback.user_id == user.id)
    )).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")
    if not (fb.is_draft or fb.withdrawn_at is not None):
        raise HTTPException(status_code=400, detail="已发出的反馈请先撤回再修改")
    if req.title is not None:
        fb.title = req.title.strip()
    if req.content is not None:
        fb.content = req.content.strip()
    if req.category is not None:
        fb.category = req.category.strip()[:32] or "other"
    if req.feedback_type is not None:
        fb.feedback_type = req.feedback_type
    if req.image_url is not None or getattr(req, "image_urls", None) is not None:
        images = _feedback_images(req.image_url, getattr(req, "image_urls", None))
        fb.image_urls = images or None
        fb.image_url = images[0] if images else None
    await db.commit()
    await db.refresh(fb)
    return FeedbackResponse(
        id=fb.id, feedback_type=fb.feedback_type, title=fb.title, content=fb.content,
        status=fb.status, upvotes_count=fb.upvotes_count,
        admin_reply=fb.admin_reply, image_url=fb.image_url, image_urls=_response_images(fb),
        user_confirm=fb.user_confirm or "", user_note=fb.user_note,
        author_id=fb.user_id, author_username=user.username,
        author_nickname=user.nickname, author_avatar=user.avatar_url,
        author_level=user.level or 1,
        created_at=fb.created_at, updated_at=fb.updated_at,
        category=fb.category or "other", is_draft=bool(fb.is_draft),
        withdrawn_at=fb.withdrawn_at,
    )


@router.post("/{feedback_id}/publish")
async def publish_feedback(
    feedback_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """发布草稿，或把已撤回的反馈重新发出。"""
    fb = (await db.execute(
        select(Feedback).where(Feedback.id == feedback_id, Feedback.user_id == user.id)
    )).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")
    if not (fb.is_draft or fb.withdrawn_at is not None):
        raise HTTPException(status_code=400, detail="该反馈已发出")
    was_draft = bool(fb.is_draft)
    fb.is_draft = False
    fb.withdrawn_at = None
    fb.status = "open" if fb.feedback_type == "bug" else "pending"

    # 补齐「作者自带的 +1 UP」：
    # 建草稿时 upvotes_count=0 且不写投票记录，此前发布只把 is_draft 改 False，
    # 导致草稿发布出去的反馈 0 票、在热度榜沉底甚至看不到。这里补齐并校准计数。
    mine = (await db.execute(
        select(FeedbackUpvote).where(
            FeedbackUpvote.feedback_id == fb.id, FeedbackUpvote.user_id == user.id,
        )
    )).scalar_one_or_none()
    first_publish = mine is None
    if first_publish:
        db.add(FeedbackUpvote(feedback_id=fb.id, user_id=user.id))
        await add_user_experience(user, 5, db)
        await record_user_activity(user, db)

    # 先 flush 再统计：SQLAlchemy 的 autoflush 会把刚 add 的票算进 count，
    # 若再加 1 会变成 2 票（真实 bug）。以库内真实票数为准，至少 1 票。
    await db.flush()
    total = int((await db.scalar(
        select(func.count()).select_from(FeedbackUpvote).where(FeedbackUpvote.feedback_id == fb.id)
    )) or 0)
    fb.upvotes_count = max(1, total)

    await db.commit()
    return {
        "ok": True, "id": str(fb.id), "from_draft": was_draft,
        "upvotes_count": fb.upvotes_count, "first_publish": first_publish,
    }


@router.post("/{feedback_id}/withdraw")
async def withdraw_feedback(
    feedback_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """作者撤回自己已发出的反馈，撤回后可在草稿箱修改并重新发布。"""
    fb = (await db.execute(
        select(Feedback).where(Feedback.id == feedback_id, Feedback.user_id == user.id)
    )).scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")
    if fb.is_draft:
        raise HTTPException(status_code=400, detail="草稿无需撤回，可直接删除")
    if fb.withdrawn_at is not None:
        raise HTTPException(status_code=400, detail="该反馈已撤回")
    fb.withdrawn_at = utc_now()
    await db.commit()
    return {"ok": True, "id": str(fb.id)}

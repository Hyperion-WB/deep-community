"""问答广场悬赏结算服务。

经验口径：全站经验（users.experience，等级 0~6），不是群经验。
悬赏由「系统经验池」虚拟账本发放，提问者不消耗自有经验；
采纳奖励绕过每日经验获取上限（属于系统奖励，不是日常行为经验），
但仍受等级上限 6 约束。
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.timezone import utc_now
from app.models.comment import Comment
from app.models.post import Category, Post
from app.models.qa import ExpLedger, QaAnswer, QaExtraQuota, QaQuestion
from app.models.system import Notification, SystemSetting
from app.models.user import User

BJ = timezone(timedelta(hours=8))
QA_ADMIN_ROLES = ("super_admin", "admin", "moderator")
QA_ACCEPT_WINDOW_DAYS = 7
QA_EXCHANGE_COST = 20
QA_MAX_ACCEPTED = 5


def qa_today() -> str:
    return datetime.now(BJ).date().isoformat()


async def qa_setting_int(db: AsyncSession, key: str, default: int) -> int:
    try:
        row = (await db.execute(
            select(SystemSetting.value).where(SystemSetting.key == key)
        )).scalar_one_or_none()
        return int(row) if row is not None else default
    except Exception:
        return default


async def is_qa_post(db: AsyncSession, post_id: Any) -> bool:
    row = (await db.execute(
        select(Post.id).join(Category, Category.id == Post.category_id)
        .where(Post.id == post_id, Category.slug == "qa")
    )).scalar_one_or_none()
    return row is not None


async def _pool_move(db: AsyncSession, delta: int) -> None:
    row = (await db.execute(
        select(SystemSetting).where(SystemSetting.key == "qa_exp_pool")
    )).scalar_one_or_none()
    if not row:
        return
    try:
        row.value = str(max(0, int(row.value or 0) + delta))
    except (TypeError, ValueError):
        row.value = str(max(0, delta))


def _ledger(db: AsyncSession, *, amount: int, direction: str, reason: str,
            user_id=None, post_id=None, comment_id=None, key: Optional[str] = None) -> None:
    db.add(ExpLedger(
        id=uuid.uuid4(), user_id=user_id, amount=amount, direction=direction,
        reason=reason, post_id=post_id, comment_id=comment_id,
        idempotency_key=key,
    ))


async def _grant_exp(db: AsyncSession, user: User, amount: int) -> int:
    """系统悬赏奖励：直接加全站经验（不过每日配额），等级上限 6。"""
    from app.services.level_service import calculate_level_from_exp

    old_level = int(user.level or 0)
    user.experience = int(user.experience or 0) + amount
    new_level = min(6, calculate_level_from_exp(user.experience))
    if getattr(user, "status", "") != "probation" and new_level > old_level:
        user.level = new_level
        db.add(Notification(
            receiver_id=user.id, sender_id=None, action_type="level_up",
            brief=f"问答采纳奖励到账 +{amount} 经验，等级提升至 Lv.{new_level}",
        ))
    await db.flush()
    return int(user.experience)


async def qa_daily_quota(db: AsyncSession, user: User) -> Dict[str, Any]:
    """今日提问名额：普通用户 1 次，管理员不限，经验可兑换额外次数。"""
    if getattr(user, "role", "") in QA_ADMIN_ROLES:
        return {"unlimited": True, "limit": 0, "used": 0, "remaining": 999}
    limit = await qa_setting_int(db, "qa_daily_question_limit", 1)
    extra = int((await db.execute(
        select(func.count()).select_from(QaExtraQuota).where(
            QaExtraQuota.user_id == user.id, QaExtraQuota.day == qa_today()
        )
    )).scalar_one() or 0)
    bj_midnight = datetime.now(BJ).replace(hour=0, minute=0, second=0, microsecond=0)
    day_start_utc = bj_midnight.astimezone(timezone.utc)
    used = int((await db.execute(
        select(func.count()).select_from(QaQuestion).where(
            QaQuestion.asker_id == user.id,
            QaQuestion.created_at >= day_start_utc,
        )
    )).scalar_one() or 0)
    return {"unlimited": False, "limit": limit + extra, "used": used,
            "remaining": max(0, limit + extra - used), "exchange_cost": QA_EXCHANGE_COST}


async def create_qa_question(db: AsyncSession, post: Post, user: User) -> Optional[QaQuestion]:
    """发帖命中 qa 分区时调用：扣减当日名额、锁定悬赏、写流水。"""
    if not await is_qa_post(db, post.id):
        return None
    quota = await qa_daily_quota(db, user)
    if not quota["unlimited"] and quota["remaining"] <= 0:
        from fastapi import HTTPException
        raise HTTPException(status_code=429, detail="今日提问名额已用完，明天再来或用经验兑换额外次数")

    bounty = await qa_setting_int(db, "qa_bounty_amount", 10)
    q = QaQuestion(
        post_id=post.id, asker_id=user.id, bounty=bounty, status="pending",
        expires_at=utc_now() + timedelta(days=QA_ACCEPT_WINDOW_DAYS),
    )
    db.add(q)
    await db.flush()
    await _pool_move(db, -bounty)
    _ledger(db, amount=bounty, direction="lock", reason="问答悬赏锁定",
            user_id=None, post_id=post.id, key=f"lock:{post.id}")
    return q


async def qa_can_answer(db: AsyncSession, post_id: Any, user: User) -> None:
    """回答前置校验：提问者不能自问自答；单用户单问题只能回答一次。"""
    from fastapi import HTTPException

    q = (await db.execute(
        select(QaQuestion).where(QaQuestion.post_id == post_id)
    )).scalar_one_or_none()
    if not q:
        return
    if q.asker_id == user.id:
        raise HTTPException(status_code=403, detail="不能回答自己提出的问题")
    if q.status != "pending":
        raise HTTPException(status_code=400, detail="该问题已结束采纳期，无法再回答")
    dup = (await db.execute(
        select(QaAnswer.id).where(QaAnswer.post_id == post_id, QaAnswer.author_id == user.id)
    )).scalar_one_or_none()
    if dup:
        raise HTTPException(status_code=409, detail="每个问题你只能回答一次，可以编辑原回答")


async def register_answer(db: AsyncSession, post_id: Any, user_id: Any, comment_id: Any) -> None:
    """登记回答；唯一约束防并发重复（楼中楼回复不登记）。"""
    if not (await db.execute(
        select(QaQuestion.post_id).where(QaQuestion.post_id == post_id)
    )).scalar_one_or_none():
        return
    stmt = pg_insert(QaAnswer.__table__).values(
        id=uuid.uuid4(), post_id=post_id, author_id=user_id,
        comment_id=comment_id, created_at=utc_now(),
    ).on_conflict_do_nothing(index_elements=["post_id", "author_id"])
    await db.execute(stmt)


async def qa_state(db: AsyncSession, post_id: Any, user: Optional[User] = None) -> Optional[Dict[str, Any]]:
    q = (await db.execute(
        select(QaQuestion).where(QaQuestion.post_id == post_id)
    )).scalar_one_or_none()
    if not q:
        return None
    exp = q.expires_at
    if exp and exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    remain = max(0, int((exp - datetime.now(timezone.utc)).total_seconds() // 86400)) if exp else 0
    out: Dict[str, Any] = {
        "bounty": q.bounty, "status": q.status, "expires_at": q.expires_at,
        "days_left": remain, "accepted_count": q.accepted_count,
        "remainder": q.remainder, "is_asker": bool(user and q.asker_id == user.id),
        "max_accepted": QA_MAX_ACCEPTED,
    }
    if user:
        out["my_answer"] = bool((await db.execute(
            select(QaAnswer.id).where(QaAnswer.post_id == post_id, QaAnswer.author_id == user.id)
        )).scalar_one_or_none())
    return out


async def settle_question(db: AsyncSession, post_id: Any, user: User,
                          comment_ids: List[Any], confirm: bool = False) -> Dict[str, Any]:
    """提问者勾选 1~5 个回答并二次确认后结算：平分悬赏、零头归池、即时发放。"""
    from fastapi import HTTPException

    if not confirm:
        raise HTTPException(status_code=400, detail="请先二次确认采纳结算")
    q = (await db.execute(
        select(QaQuestion).where(QaQuestion.post_id == post_id).with_for_update()
    )).scalar_one_or_none()
    if not q:
        raise HTTPException(status_code=404, detail="该问题不存在")
    if q.asker_id != user.id:
        raise HTTPException(status_code=403, detail="仅提问者可采纳回答")
    if q.status != "pending":
        raise HTTPException(status_code=400, detail="该问题已结算或已过期")
    if q.expires_at and q.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="已采纳期结束，无法结算")

    ids = list(dict.fromkeys(str(c) for c in comment_ids))
    if not (1 <= len(ids) <= QA_MAX_ACCEPTED):
        raise HTTPException(status_code=400, detail=f"一次可采纳 1~{QA_MAX_ACCEPTED} 个回答")

    rows = (await db.execute(
        select(Comment).where(Comment.id.in_(ids), Comment.post_id == post_id,
                              Comment.status == "visible", Comment.parent_id.is_(None))
    )).scalars().all()
    if len(rows) != len(ids):
        raise HTTPException(status_code=400, detail="存在无效或已删除的回答")
    if any(c.author_id == q.asker_id for c in rows):
        raise HTTPException(status_code=403, detail="不能采纳自己的回答")

    per = q.bounty // len(rows)              # 向下取整
    remainder = q.bounty - per * len(rows)  # 零头归系统积分池
    if per <= 0:
        raise HTTPException(status_code=400, detail="采纳人数过多，人均悬赏为 0")

    for c in rows:
        author = (await db.execute(select(User).where(User.id == c.author_id))).scalar_one_or_none()
        if not author:
            continue
        await _grant_exp(db, author, per)
        c.is_accepted = True
        _ledger(db, amount=per, direction="grant", reason="问答采纳奖励",
                user_id=author.id, post_id=post_id, comment_id=c.id,
                key=f"grant:{post_id}:{c.id}")

    q.status = "solved"
    q.settled_at = utc_now()
    q.accepted_count = len(rows)
    q.remainder = remainder
    if remainder:
        await _pool_move(db, remainder)
        _ledger(db, amount=remainder, direction="remainder", reason="问答悬赏零头归池",
                user_id=None, post_id=post_id, key=f"remainder:{post_id}")

    post = (await db.execute(select(Post).where(Post.id == post_id))).scalar_one_or_none()
    if post and rows:
        post.accepted_comment_id = rows[0].id

    for c in rows:
        if c.author_id:
            db.add(Notification(
                receiver_id=c.author_id, sender_id=user.id, action_type="accepted_solution",
                target_id=post_id, comment_id=c.id,
                brief=f"你的回答被采纳，获得「问答采纳奖励」+{per} 经验！",
            ))
    await db.commit()
    return {"ok": True, "accepted": len(rows), "per_person": per,
            "remainder": remainder, "status": "solved"}


async def refund_question(db: AsyncSession, post_id: Any, reason: str) -> bool:
    """问题删除 / 超时：未结算悬赏原路退回系统经验池。"""
    q = (await db.execute(
        select(QaQuestion).where(QaQuestion.post_id == post_id).with_for_update()
    )).scalar_one_or_none()
    if not q or q.status != "pending":
        return False
    q.status = "refunded" if reason == "deleted" else "expired"
    q.settled_at = utc_now()
    await _pool_move(db, q.bounty)
    _ledger(db, amount=q.bounty, direction="refund",
            reason="悬赏退回（问题删除）" if reason == "deleted" else "悬赏退回（采纳期超时）",
            user_id=None, post_id=post_id, key=f"refund:{post_id}:{q.status}")
    await db.commit()
    return True


async def clawback_answer(db: AsyncSession, comment_id: Any) -> int:
    """回答违规/删除：扣回该回答已发放的采纳奖励。"""
    grants = (await db.execute(
        select(ExpLedger).where(ExpLedger.comment_id == comment_id,
                                ExpLedger.reason == "问答采纳奖励",
                                ExpLedger.direction == "grant")
    )).scalars().all()
    total = 0
    for g in grants:
        already = (await db.execute(
            select(ExpLedger.id).where(ExpLedger.idempotency_key == f"clawback:{g.id}")
        )).scalar_one_or_none()
        if already:
            continue
        user = (await db.execute(select(User).where(User.id == g.user_id))).scalar_one_or_none()
        if user:
            user.experience = max(0, int(user.experience or 0) - g.amount)
        total += g.amount
        _ledger(db, amount=g.amount, direction="clawback", reason="违规扣回问答采纳奖励",
                user_id=g.user_id, post_id=g.post_id, comment_id=comment_id,
                key=f"clawback:{g.id}")
    if total:
        await _pool_move(db, total)
        await db.commit()
    return total


async def expire_qa_questions(db: AsyncSession, batch: int = 200) -> int:
    """定时任务：7 天采纳期到期、仍未结算的问题自动标记「已过期」并退回悬赏。"""
    qids = (await db.execute(
        select(QaQuestion.post_id).where(
            QaQuestion.status == "pending", QaQuestion.expires_at <= datetime.now(timezone.utc)
        ).limit(batch)
    )).scalars().all()
    n = 0
    for pid in qids:
        if await refund_question(db, pid, "expired"):
            n += 1
    return n


async def exchange_extra_quota(db: AsyncSession, user: User) -> Dict[str, Any]:
    """用全站经验兑换今日额外 1 次提问名额。"""
    from fastapi import HTTPException
    from app.services.level_service import deduct_user_experience

    cost = QA_EXCHANGE_COST
    if int(user.experience or 0) < cost:
        raise HTTPException(status_code=400, detail=f"经验不足，兑换需要 {cost} 点全站经验")
    await deduct_user_experience(user, cost, db, reason="兑换问答广场额外提问名额")
    db.add(QaExtraQuota(id=uuid.uuid4(), user_id=user.id, day=qa_today(), source="exchange"))
    _ledger(db, amount=cost, direction="clawback", reason="兑换额外提问名额",
            user_id=user.id, key=f"exchange:{user.id}:{qa_today()}:{uuid.uuid4().hex[:8]}")
    await db.commit()
    return {"ok": True, "cost": cost, **(await qa_daily_quota(db, user))}

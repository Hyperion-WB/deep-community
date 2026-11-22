"""等级/经验/活跃度服务。

事务约定（重要）：本模块**不再自行 commit**，只负责修改 ORM 对象并 flush。
提交边界统一由路由层的 `get_db` 依赖（请求结束）或路由内显式 `commit` 控制，
避免一个请求多次提交造成"帖子已入库、投票未建"这类半提交状态。
"""
from datetime import date
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from app.models.user import User
from app.models.system import Notification
from app.core.config import settings

# 等级经验对照表
LEVEL_EXP_THRESHOLDS = [
    (0, 0),       # Lv.0: 0 EXP
    (1, 1),       # Lv.1: 1 ~ 99
    (2, 100),     # Lv.2: 100 ~ 299
    (3, 300),     # Lv.3: 300 ~ 799
    (4, 800),     # Lv.4: 800 ~ 1999
    (5, 2000),    # Lv.5: 2000 ~ 4999
    (6, 5000),    # Lv.6: 5000+
]

def calculate_level_from_exp(exp: int) -> int:
    """根据累计经验计算对应等级"""
    curr_level = 0
    for lvl, threshold in LEVEL_EXP_THRESHOLDS:
        if exp >= threshold:
            curr_level = lvl
        else:
            break
    return curr_level

async def record_user_activity(user: User, db: AsyncSession) -> bool:
    """
    记录用户今日有效活跃:
    若是今天第一次产生交互，增加活跃天数；
    若达到 5 天且处于见习状态，触发自动晋升转正。
    返回是否今天计入了新的一天。
    """
    today = date.today()
    if user.last_active_date == today:
        return False

    user.last_active_date = today
    user.active_days += 1
    
    # 判定见习转正
    if user.status == "probation" and user.active_days >= settings.PROBATION_ACTIVE_DAYS_REQUIRED:
        user.status = "active"
        # 转正根据已累积的经验核算对应等级，保底为 Lv.1 (经验保底 1)
        calc_lvl = calculate_level_from_exp(user.experience)
        user.level = max(1, calc_lvl)
        if user.experience < 1:
            user.experience = 1

        # 派发系统转正喜讯
        notice = Notification(
            receiver_id=user.id,
            action_type="level_up",
            brief=f"恭喜你完成 {settings.PROBATION_ACTIVE_DAYS_REQUIRED} 天活跃观察期，正式成为社区正式会员！已解锁全部发帖、私信与匿名特权。"
        )
        db.add(notice)

    await db.flush()
    return True

async def get_system_setting_int(db: AsyncSession, key: str, default: int) -> int:
    """获取系统运行配置整型值，带安全容错默认值"""
    try:
        from app.models.system import SystemSetting
        res = await db.execute(select(SystemSetting.value).where(SystemSetting.key == key))
        val = res.scalar_one_or_none()
        if val is not None:
            return int(val)
    except Exception:
        pass
    return default

async def set_user_level(user: User, new_level: int, db: AsyncSession, experience: int = None) -> int:
    """由管理员或系统脚本直接设置用户等级与对应经验值。

    一致性保障：level 必须与 calculate_level_from_exp(experience) 匹配，
    否则用户后续任何一次 +EXP 都会触发无条件重算，导致等级被静默打回。
    """
    new_level = max(0, min(6, int(new_level)))
    threshold = next((th for lvl, th in LEVEL_EXP_THRESHOLDS if lvl == new_level), 0)

    if experience is not None and experience >= 0:
        # 管理员显式给了经验值：若与目标等级脱钩，强制对齐到该等级起始阈值，
        # 避免下次 +EXP 时等级被重算逻辑静默降级/升级
        if calculate_level_from_exp(int(experience)) != new_level:
            user.experience = threshold
        else:
            user.experience = int(experience)
    else:
        # 默认匹配该等级标准起始阈值
        user.experience = threshold
    user.level = new_level

    notice = Notification(
        receiver_id=user.id,
        action_type="level_up" if new_level > 0 else "system",
        brief=f"管理员已将你的极客社区等级调整为 Lv.{new_level}（当前经验值：{user.experience} EXP）。"
    )
    db.add(notice)
    await db.flush()
    return user.level

async def add_user_experience(user: User, exp_gain: int, db: AsyncSession) -> int:
    """增加用户经验值，受每日获取上限保护并自动触发升级判定"""
    if exp_gain <= 0:
        return user.level

    today = date.today()
    if user.today_exp_date != today:
        user.today_exp_date = today
        user.today_exp_gained = 0

    daily_exp_limit = await get_system_setting_int(db, "daily_exp_limit", 60)
    current_today_exp = user.today_exp_gained or 0
    remaining_quota = max(0, daily_exp_limit - current_today_exp)

    if remaining_quota <= 0:
        # 今日经验已达上限，不再继续增加经验，但仍记录有效互动
        return user.level

    actual_gain = min(exp_gain, remaining_quota)
    user.today_exp_gained = current_today_exp + actual_gain
    user.experience += actual_gain

    # 见习期用户 (probation) 处于考核观察期，等级固定锁定为 Lv.0。
    # 经验正常累积，待达到 5 天活跃或管理员审核转正后，一次性核算其实际等级！
    if user.status == "probation":
        user.level = 0
        await db.flush()
        return 0

    new_level = calculate_level_from_exp(user.experience)
    
    if new_level > user.level:
        old_level = user.level
        user.level = new_level
        notice = Notification(
            receiver_id=user.id,
            action_type="level_up",
            brief=f"恭喜你等级提升至 Lv.{new_level}！解锁了更多社区专属特权与每日匿名额度。"
        )
        db.add(notice)

    await db.flush()
    return user.level

async def deduct_user_experience(user: User, exp_loss: int, db: AsyncSession, reason: str = "") -> int:
    """
    扣减用户经验值，并自动触发等级重新核算（用于下架/删帖防刷、违规扣分）。
    防刷与降级保障：
    1. 正式会员 (active) 经验保底为 1，等级保底为 Lv.1，避免降为见习会员；
    2. 见习会员 (probation) 经验保底为 0，等级为 Lv.0；
    3. 若经验跌破当前等级门槛，相应下调等级；
    4. 产生系统扣除与降级通知。
    """
    if exp_loss <= 0:
        return user.level

    old_level = user.level
    min_exp = 1 if user.status == "active" else 0
    user.experience = max(min_exp, user.experience - exp_loss)

    new_level = calculate_level_from_exp(user.experience)
    if user.status == "active" and new_level < 1:
        new_level = 1

    user.level = new_level

    if reason:
        brief_msg = f"{reason}，扣回 {exp_loss} 点经验。当前经验值: {user.experience} (Lv.{user.level})"
        notice = Notification(
            receiver_id=user.id,
            action_type="level_down" if new_level < old_level else "system",
            brief=brief_msg
        )
        db.add(notice)

    await db.flush()
    return user.level


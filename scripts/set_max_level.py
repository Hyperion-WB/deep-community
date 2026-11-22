import asyncio
import sys
import os

# 将 backend 路径加入 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from app.core.database import AsyncSessionLocal
from app.models.user import User
from app.models.system import Notification
from sqlalchemy import select, or_

async def main():
    target_name = sys.argv[1] if len(sys.argv) > 1 else "伴野星辰"
    print(f"[*] 正在检索用户：{target_name} ...")

    async with AsyncSessionLocal() as db:
        # 支持按用户名完全匹配、按昵称匹配、或模糊匹配
        query = select(User).where(
            or_(
                User.username == target_name,
                User.nickname == target_name,
                User.username.ilike(f"%{target_name}%"),
                User.nickname.ilike(f"%{target_name}%")
            )
        )
        res = await db.execute(query)
        users = res.scalars().all()

        if not users:
            print(f"[!] 未找到匹配用户: {target_name}")
            print("[*] 建议登录管理后台【极客成员与角色任免】列表中查看该用户的精确用户名。")
            return

        for u in users:
            old_level = u.level
            old_exp = u.experience
            u.level = 6
            u.experience = max(5000, u.experience)
            if u.status == "probation":
                u.status = "active"

            notif = Notification(
                receiver_id=u.id,
                action_type="level_up",
                brief="【系统指令】恭喜！管理员已将你的极客社区等级调整为最高满级 Lv.6（传奇宗师 / 5000+ EXP）！"
            )
            db.add(notif)
            print(f"[✓] 成功为用户 @{u.username} (昵称: {u.nickname or '未设'}) 赋予满级特权:")
            print(f"    - 原等级/经验: Lv.{old_level} ({old_exp} EXP)")
            print(f"    - 新等级/经验: Lv.{u.level} ({u.experience} EXP)")
            print(f"    - 状态: {u.status}")

        await db.commit()
        print("[*] 全部调整已持久化至数据库！")

if __name__ == "__main__":
    asyncio.run(main())

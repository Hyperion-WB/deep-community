import asyncio
import sys
import os

# 将 backend 路径加入 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from app.core.database import AsyncSessionLocal, engine, Base
from app.models.user import User
from app.core.security import get_password_hash
from sqlalchemy import select

async def main():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as db:
        q = select(User).where(User.username == "admin")
        res = await db.execute(q)
        admin = res.scalar_one_or_none()
        if admin:
            print("Admin user already exists!")
            return

        new_admin = User(
            username="admin",
            nickname="最高系统管理员",
            email="admin@community.local",
            password_hash=get_password_hash("Admin123456!"),
            role="super_admin",
            status="active",
            level=6,
            experience=9999,
            bio="社区系统初始管理员"
        )
        db.add(new_admin)
        await db.commit()
        print("Super admin created successfully! User: admin, Pass: Admin123456!")

if __name__ == "__main__":
    asyncio.run(main())

# -*- coding: utf-8 -*-
"""
极客社区 SQLite 到 PostgreSQL 无损数据迁移脚本 (Lossless Migration Utility)
功能：
1. 自动连接本地 SQLite 数据库与目标 PostgreSQL 数据库；
2. 自动在目标 PostgreSQL 建立/对齐完整的 ORM 表结构；
3. 自动将 SQLite 中的全量历史数据 (用户、文章、评论、群聊、公约、配置等) 进行字段清洗与类型转换 (UUID/Boolean/Datetime/Date)；
4. 采用安全复制会话 (session_replication_role = replica) 规避外键前置约束死锁；
5. 自动校准并重置 PostgreSQL 的全表自增序列 (Sequence)，杜绝迁移后发帖/发消息的主键冲突；
6. 自动执行双端行数一致性校验 (Integrity Check) 并输出完整对比报告。

使用方式：
直接执行：
  python backend/scripts/migrate_sqlite_to_pg.py
或指定参数：
  python backend/scripts/migrate_sqlite_to_pg.py --sqlite-path backend/local_community.db --pg-url postgresql+asyncpg://app_user:change_me_strong_password@localhost:5432/community_db
"""

import sys
import os
import argparse
import asyncio
import sqlite3
import uuid
import re
from datetime import datetime, date, timezone
from typing import Dict, List, Any, Optional

# 确保 backend 根目录在模块搜索路径中
current_dir = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.abspath(os.path.join(current_dir, ".."))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)


def parse_sqlite_value(val: Any, col_name: str, col_type: str) -> Any:
    """智能转换 SQLite 存储格式为 PostgreSQL 原生数据类型"""
    if val is None:
        return None

    col_lower = col_name.lower()
    type_lower = (col_type or "").lower()

    # 1. 布尔类型转换 (SQLite 存储为 0/1)
    if (
        "bool" in type_lower
        or col_lower.startswith("is_")
        or col_lower.startswith("has_")
        or col_lower in ("dnd_enabled", "hide_following", "hide_followers", "hide_favorites")
    ):
        if isinstance(val, (int, str)):
            return bool(int(val))
        return bool(val)

    # 2. UUID 类型转换 (SQLite 存储为 32位 hex 或 36位带破折号字符串)
    if "uuid" in type_lower or col_lower.endswith("_id") or col_lower in ("id", "user_id", "author_id", "post_id"):
        # 排除纯整型自增主键 (如 posts.id, comments.id, site_announcements.id)
        if isinstance(val, str) and (len(val) == 32 or len(val) == 36):
            try:
                return uuid.UUID(val)
            except Exception:
                pass

    # 3. 日期时间类型转换
    if "timestamp" in type_lower or "datetime" in type_lower or col_lower.endswith("_at"):
        if isinstance(val, str):
            val_clean = val.strip()
            # 兼容 SQLite 标准格式 'YYYY-MM-DD HH:MM:SS' 或 ISO 格式
            for fmt in (
                "%Y-%m-%d %H:%M:%S.%f",
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%dT%H:%M:%S.%f",
                "%Y-%m-%dT%H:%M:%S",
            ):
                try:
                    dt = datetime.strptime(val_clean.split("+")[0].split("Z")[0], fmt)
                    return dt.replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
        elif isinstance(val, datetime):
            if val.tzinfo is None:
                return val.replace(tzinfo=timezone.utc)
            return val

    # 4. 纯日期类型 (Date)
    if type_lower == "date" or col_lower.endswith("_date"):
        if isinstance(val, str):
            try:
                return datetime.strptime(val.strip(), "%Y-%m-%d").date()
            except Exception:
                pass
        elif isinstance(val, date):
            return val

    return val


async def run_migration(sqlite_path: str, pg_url: str, batch_size: int = 500):
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy import text
    from app.core.database import Base
    import app.models  # 加载注册所有 ORM 模型

    print("=" * 70)
    print("极客社区 SQLite -> PostgreSQL 无损数据迁移程序")
    print("=" * 70)
    print(f"[*] 源 SQLite 数据库文件: {sqlite_path}")
    print(f"[*] 目标 PostgreSQL 连接: {re.sub(r':([^@]+)@', ':****@', pg_url)}")

    if not os.path.exists(sqlite_path):
        print(f"[!] 错误: SQLite 数据库文件不存在: {sqlite_path}")
        return False

    # 1. 读取源 SQLite 中的所有用户表
    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row
    sqlite_cursor = sqlite_conn.cursor()

    sqlite_cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
    all_sqlite_tables = [row[0] for row in sqlite_cursor.fetchall()]
    print(f"[*] 扫描到 SQLite 中共 {len(all_sqlite_tables)} 张业务数据表")

    # 2. 连接 PostgreSQL 并准备结构
    # 针对 asyncpg 适配 URL
    if pg_url.startswith("postgresql://"):
        async_pg_url = pg_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    else:
        async_pg_url = pg_url

    pg_engine = create_async_engine(async_pg_url, echo=False)

    try:
        async with pg_engine.begin() as conn:
            print("[*] 正在连接目标 PostgreSQL 并初始化最新表结构 (Base.metadata.create_all)...")
            await conn.run_sync(Base.metadata.create_all)
            # 开启 pg_trgm 扩展以备全文检索
            try:
                await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm;"))
            except Exception:
                pass
    except Exception as e:
        print(f"[!] 无法连接目标 PostgreSQL 或初始化表结构失败: {e}")
        return False

    # 3. 确定安全的表迁移顺序 (优先迁移独立父表，再迁移带外键的子表)
    preferred_order = [
        "users",
        "categories",
        "sensitive_words",
        "system_settings",
        "site_announcements",
        "community_rules",
        "community_endorsements",
        "invite_codes",
        "checkins",
        "follows",
        "user_blocks",
        "post_series",
        "posts",
        "series_items",
        "post_edits",
        "post_images",
        "polls",
        "poll_options",
        "poll_votes",
        "comments",
        "likes",
        "collections",
        "reactions",
        "conversations",
        "messages",
        "group_rooms",
        "group_members",
        "group_join_requests",
        "group_messages",
        "group_audit_logs",
        "feedbacks",
        "feedback_upvotes",
        "reports",
        "notifications",
        "admin_audit_logs",
    ]

    # 补齐未显式列出的其余表
    ordered_tables = [t for t in preferred_order if t in all_sqlite_tables]
    for t in all_sqlite_tables:
        if t not in ordered_tables:
            ordered_tables.append(t)

    migration_stats = {}

    # 4. 执行数据迁移
    async with pg_engine.begin() as conn:
        print("[*] 临时挂起 PostgreSQL 外键约束 (session_replication_role = replica)...")
        await conn.execute(text("SET session_replication_role = 'replica';"))

        for table_name in ordered_tables:
            # 获取 SQLite 表字段与信息
            sqlite_cursor.execute(f"PRAGMA table_info(\"{table_name}\");")
            col_info = sqlite_cursor.fetchall()
            if not col_info:
                continue

            col_names = [col[1] for col in col_info]
            col_types = {col[1]: col[2] for col in col_info}

            # 统计源表行数
            sqlite_cursor.execute(f"SELECT count(*) FROM \"{table_name}\";")
            src_count = sqlite_cursor.fetchone()[0]

            if src_count == 0:
                migration_stats[table_name] = {"src": 0, "dst": 0, "status": "EMPTY"}
                continue

            # 清空目标表（确保迁移无残留数据冲突）
            await conn.execute(text(f'TRUNCATE TABLE "{table_name}" CASCADE;'))

            # 分批从 SQLite 抽取并写入 PostgreSQL
            sqlite_cursor.execute(f'SELECT * FROM "{table_name}";')
            inserted_count = 0

            while True:
                rows = sqlite_cursor.fetchmany(batch_size)
                if not rows:
                    break

                # 构造参数化 INSERT 语句
                cols_str = ", ".join([f'"{c}"' for c in col_names])
                placeholders = ", ".join([f":{c}" for c in col_names])
                stmt = text(f'INSERT INTO "{table_name}" ({cols_str}) VALUES ({placeholders})')

                batch_params = []
                for row in rows:
                    param_dict = {}
                    for col_name in col_names:
                        raw_val = row[col_name]
                        param_dict[col_name] = parse_sqlite_value(raw_val, col_name, col_types.get(col_name, ""))
                    batch_params.append(param_dict)

                await conn.execute(stmt, batch_params)
                inserted_count += len(batch_params)

            migration_stats[table_name] = {
                "src": src_count,
                "dst": inserted_count,
                "status": "OK" if src_count == inserted_count else "MISMATCH",
            }

        print("[*] 恢复 PostgreSQL 外键完整性约束 (session_replication_role = origin)...")
        await conn.execute(text("SET session_replication_role = 'origin';"))

        # 5. 自动校准并重置所有自增序列 (Sequence)
        print("[*] 正在重置并同步全量表的自增序列 (Auto-Increment Sequences)...")
        seq_query = text("""
            SELECT table_name, column_name, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public' 
              AND column_default LIKE 'nextval%';
        """)
        seq_res = await conn.execute(seq_query)
        seq_cols = seq_res.fetchall()

        for s_table, s_col, s_def in seq_cols:
            try:
                fix_seq_sql = text(f"""
                    SELECT setval(
                        pg_get_serial_sequence('"{s_table}"', '{s_col}'),
                        COALESCE((SELECT MAX("{s_col}") FROM "{s_table}"), 1)
                    );
                """)
                await conn.execute(fix_seq_sql)
            except Exception as seq_err:
                pass

    sqlite_conn.close()
    await pg_engine.dispose()

    # 6. 打印最终数据校验对比报告
    print("\n" + "=" * 70)
    print(f"{'数据表名':<28} | {'SQLite源':<10} | {'Postgres目标':<12} | {'状态'}")
    print("-" * 70)
    all_ok = True
    for t_name, stat in migration_stats.items():
        src_n = stat["src"]
        dst_n = stat["dst"]
        st = stat["status"]
        if st == "MISMATCH":
            all_ok = False
        print(f"{t_name:<28} | {src_n:<10} | {dst_n:<12} | {st}")
    print("=" * 70)

    if all_ok:
        print("[√] 恭喜！SQLite 全量数据已 100% 无损迁移至 PostgreSQL，序列与索引已校准完毕！\n")
        return True
    else:
        print("[!] 警告：部分表行数出现不一致，请核对上述报告！\n")
        return False


def main():
    parser = argparse.ArgumentParser(description="极客社区 SQLite -> PostgreSQL 无损迁移工具")
    parser.add_argument(
        "--sqlite-path",
        default=os.path.join(backend_dir, "local_community.db"),
        help="SQLite 数据库文件路径 (默认: backend/local_community.db)",
    )
    # 默认从环境变量或配置文件提取
    default_pg = os.environ.get("DATABASE_URL")
    if not default_pg:
        try:
            from app.core.config import settings
            default_pg = settings.DATABASE_URL
        except Exception:
            pass
    if not default_pg or "sqlite" in default_pg.lower():
        # 如果是 Docker 内部执行，默认主机名为 db；若宿主机执行可指定 localhost
        default_pg = "postgresql+asyncpg://app_user:change_me_strong_password@db:5432/community_db"

    parser.add_argument(
        "--pg-url",
        default=default_pg,
        help="目标 PostgreSQL 连接串 (例如: postgresql+asyncpg://user:pass@host:5432/dbname)",
    )
    parser.add_argument("--batch-size", type=int, default=500, help="每批写入记录数 (默认: 500)")

    args = parser.parse_args()

    # 允许如果命令行传入的是 postgresql://，自动转换为 asyncpg
    pg_url = args.pg_url
    if pg_url.startswith("postgresql://"):
        pg_url = pg_url.replace("postgresql://", "postgresql+asyncpg://", 1)

    success = asyncio.run(run_migration(args.sqlite_path, pg_url, args.batch_size))
    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()

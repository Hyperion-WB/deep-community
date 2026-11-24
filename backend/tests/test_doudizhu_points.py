import asyncio
import os
from datetime import date, datetime, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import insert, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.schema import CreateSchema, DropSchema

from app.core.database import Base, get_db
from app.core.migrations import _USER_TITLES
from app.core.security import create_access_token
from app.models.game_platform import (
    BattleSeasonStat, DouDizhuCheckIn, GameDef, SeasonRegistry, SeasonScore, SeasonSnapshot,
)
from app.models.user import User
from app.routers import doudizhu_points, minigames


def make_app():
    app = FastAPI()
    app.include_router(doudizhu_points.router)
    app.include_router(minigames.router)
    return app


@pytest_asyncio.fixture
async def postgres_sessions():
    dsn = os.getenv("TEST_POSTGRES_DSN")
    if not dsn:
        pytest.skip("TEST_POSTGRES_DSN must point to a disposable PostgreSQL test database")

    schema = f"test_doudizhu_{uuid4().hex}"
    engine = create_async_engine(
        dsn,
        execution_options={"schema_translate_map": {None: schema}},
        connect_args={"server_settings": {"search_path": schema}},
    )
    tables = [model.__table__ for model in (
        User, GameDef, SeasonRegistry, SeasonScore, SeasonSnapshot, BattleSeasonStat, DouDizhuCheckIn,
    )]
    try:
        async with engine.begin() as connection:
            await connection.execute(CreateSchema(schema))
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=tables))
            await connection.execute(text(_USER_TITLES[0]))
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        try:
            async with engine.begin() as connection:
                await connection.execute(DropSchema(schema, cascade=True, if_exists=True))
        finally:
            await engine.dispose()


@pytest.mark.asyncio
async def test_points_requires_authentication():
    async with AsyncClient(transport=ASGITransport(app=make_app()), base_url="http://test") as client:
        assert (await client.get("/doudizhu/points")).status_code == 401
        assert (await client.post("/doudizhu/points/check-in")).status_code == 401


@pytest.mark.asyncio
async def test_concurrent_check_ins_award_once_and_reset_at_shanghai_midnight(postgres_sessions, monkeypatch):
    first, second = uuid4(), uuid4()
    async with postgres_sessions() as session:
        await session.execute(insert(User), [
            {"id": uid, "username": username, "email": f"{username}@test.invalid", "password_hash": "test"}
            for uid, username in [(first, "first"), (second, "second")]
        ])
        await session.commit()

    async def db_override():
        async with postgres_sessions() as session:
            yield session

    app = make_app()
    app.dependency_overrides[get_db] = db_override
    now = datetime(2020, 1, 31, 15, 59, tzinfo=timezone.utc)
    monkeypatch.setattr(doudizhu_points, "utc_now", lambda: now)
    headers = {"Authorization": f"Bearer {create_access_token(first, 'user')}"}
    other_headers = {"Authorization": f"Bearer {create_access_token(second, 'user')}"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        initial = await client.get("/doudizhu/points", headers=headers)
        assert initial.json() == {"points": 0, "checkedIn": False, "dailyReward": 10}

        awards = await asyncio.gather(*[
            client.post("/doudizhu/points/check-in", headers=headers) for _ in range(8)
        ])
        for award in awards:
            assert award.status_code == 200
            assert award.json() == {"points": 10, "checkedIn": True, "dailyReward": 10}
        assert (await client.get("/doudizhu/points", headers=other_headers)).json() == initial.json()

        now = datetime(2020, 1, 31, 16, tzinfo=timezone.utc)
        reset = await client.get("/doudizhu/points", headers=headers)
        assert reset.json() == {"points": 10, "checkedIn": False, "dailyReward": 10}
        second_day = await client.post("/doudizhu/points/check-in", headers=headers)
        assert second_day.json() == {"points": 20, "checkedIn": True, "dailyReward": 10}


@pytest.mark.asyncio
async def test_check_in_bonus_is_capped_and_archived_without_check_in_only_medals(postgres_sessions, monkeypatch):
    monkeypatch.setattr(minigames, "current_season_id", lambda: "2020-02")
    monkeypatch.setattr(minigames, "utc_now", lambda: datetime(2020, 2, 2, tzinfo=timezone.utc))
    first, second, check_in_only = uuid4(), uuid4(), uuid4()
    async with postgres_sessions() as session:
        await session.execute(insert(User), [
            {"id": uid, "username": username, "email": f"{username}@test.invalid",
             "password_hash": "test", "status": "active"}
            for uid, username in [(first, "first"), (second, "second"), (check_in_only, "check_in_only")]
        ])
        await session.execute(insert(GameDef).values(code="2048", name="2048"))
        await session.execute(insert(SeasonScore), [
            {"season_id": season, "game": "2048", "user_id": uid, "season_score": 80}
            for season in ["2020-01", "2020-02"] for uid in [first, second]
        ])
        await session.execute(insert(DouDizhuCheckIn), [
            {"user_id": first, "check_in_day": date(2020, 1, day), "reward": 10} for day in range(1, 32)
        ] + [
            {"user_id": second, "check_in_day": date(2020, 2, 1), "reward": 10},
            {"user_id": check_in_only, "check_in_day": date(2020, 1, 1), "reward": 10},
        ])
        await session.commit()

        sign_in_user = await session.get(User, check_in_only)
        january = await minigames.overall_leaderboard(season="2020-01", db=session, user=sign_in_user)
        assert january["my_rank"] == 3
        assert [(row["user_id"], row["total_score"]) for row in january["items"]] == [
            (str(first), 63), (str(second), 60), (str(check_in_only), 0.1),
        ]
        assert january["items"][0]["breakdown"]["doudizhu_check_in"] == 3
        february = await minigames.overall_leaderboard(season="2020-02", db=session, user=sign_in_user)
        assert [(row["user_id"], row["total_score"]) for row in february["items"]] == [
            (str(second), 60.1), (str(first), 60),
        ]

        settlement = await minigames.settle_game_season(session, "2020-01")
        assert [medal["user_id"] for medal in settlement["medals"]] == [str(first), str(second)]
        assert set((await session.scalars(text("SELECT user_id FROM user_titles"))).all()) == {first, second}
        archived = await minigames.overall_leaderboard(season="2020-01", db=session, user=sign_in_user)
        assert archived["my_rank"] == 3
        for live, snapshot in zip(january["items"], archived["items"], strict=True):
            for key in ("rank", "user_id", "total_score", "breakdown"):
                assert snapshot[key] == live[key]

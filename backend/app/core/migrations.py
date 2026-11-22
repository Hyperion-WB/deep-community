"""版本化数据库迁移（PostgreSQL）。

背景：此前每次启动都无条件执行一大串 ALTER TABLE，既无法知道"当前库是哪个版本"，
也不能在回滚/多实例部署时保证一致性。这里改为：
- `schema_migrations` 记录已应用版本；
- 启动时用 PostgreSQL 咨询锁串行化，多 worker / 多副本同时启动也只会迁移一次；
- 每条语句单独事务执行，失败只记录并跳过（兼容历史脏数据，避免服务起不来）；
- 新增变更只需在 MIGRATIONS 末尾追加一个版本。

注意：本项目已不再支持 SQLite，迁移语句为 PostgreSQL 方言。
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

# 迁移锁的固定 key（任意常量，保证所有实例抢同一把锁）
_MIGRATION_LOCK_KEY = 941_023_001

# 基线：与旧版本启动时执行的 ALTER/索引完全一致，对已有库与全新库都幂等
_BASELINE = [
    # ---- users ----
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(32);",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname_change_count INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname_last_change_month VARCHAR(7);",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS dnd_enabled BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_following BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_followers BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_favorites BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS today_exp_gained INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS today_exp_date DATE;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS equipped_title VARCHAR(64);",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(16) NOT NULL DEFAULT 'secret';",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tech_stack VARCHAR(255) NOT NULL DEFAULT '';",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS github_url VARCHAR(255) NOT NULL DEFAULT '';",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS blog_url VARCHAR(255) NOT NULL DEFAULT '';",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS ip_location VARCHAR(64) NOT NULL DEFAULT '';",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id VARCHAR(32);",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_github_id ON users(github_id) WHERE github_id IS NOT NULL;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS gitee_id VARCHAR(32);",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_gitee_id ON users(gitee_id) WHERE gitee_id IS NOT NULL;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_changed_at TIMESTAMPTZ;",
    # ---- posts ----
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS tags VARCHAR(255);",
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_essence BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS accepted_comment_id UUID;",
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS first_published_at TIMESTAMPTZ;",
    # ---- comments ----
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_accepted BOOLEAN NOT NULL DEFAULT FALSE;",
    # ---- 群聊 / 私聊 ----
    "ALTER TABLE group_rooms ADD COLUMN IF NOT EXISTS announcement TEXT DEFAULT '';",
    "ALTER TABLE group_rooms ADD COLUMN IF NOT EXISTS announcement_updated_at TIMESTAMPTZ;",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;",
    "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS seq_id BIGINT;",
    "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS is_recalled BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS msg_type VARCHAR(16) NOT NULL DEFAULT 'text';",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq_id BIGINT;",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_recalled BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type VARCHAR(16) NOT NULL DEFAULT 'text';",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_small_deleted_at TIMESTAMPTZ;",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_big_deleted_at TIMESTAMPTZ;",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_small_cleared_at TIMESTAMPTZ;",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_big_cleared_at TIMESTAMPTZ;",
    # ---- 通知 / 公告 / 反馈 ----
    "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS comment_id UUID;",
    "ALTER TABLE site_announcements ADD COLUMN IF NOT EXISTS title VARCHAR(200) DEFAULT '';",
    "ALTER TABLE site_announcements ALTER COLUMN content TYPE TEXT;",
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS admin_reply TEXT;",
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS admin_replied_by UUID;",
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS admin_replied_at TIMESTAMPTZ;",
    # ---- 索引 ----
    "CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id);",
    "CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_type, target_id);",
    "CREATE INDEX IF NOT EXISTS idx_notifications_receiver_read ON notifications(receiver_id, is_read);",
    "CREATE INDEX IF NOT EXISTS ix_posts_status_created ON posts(status, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS ix_posts_status_pinned ON posts(status, is_pinned DESC, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS ix_comments_post_parent_status ON comments(post_id, parent_id, status, created_at);",
    "CREATE INDEX IF NOT EXISTS ix_messages_conv_created ON messages(conversation_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS ix_group_messages_room_seq ON group_messages(room_id, created_at DESC, seq_id DESC);",
    "CREATE INDEX IF NOT EXISTS ix_notifications_receiver_read_created ON notifications(receiver_id, is_read, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS ix_follows_following_created ON follows(following_id, created_at DESC);",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_group_apply_pending ON group_join_requests(room_id, user_id) WHERE status = 'pending';",
    "ALTER TABLE admin_audit_logs ALTER COLUMN admin_id DROP NOT NULL;",
    # ---- 全文检索 ----
    "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
    "CREATE INDEX IF NOT EXISTS ix_posts_title_trgm ON posts USING gin (title gin_trgm_ops);",
    "CREATE INDEX IF NOT EXISTS ix_posts_tags_trgm ON posts USING gin (tags gin_trgm_ops);",
    "CREATE INDEX IF NOT EXISTS ix_posts_content_trgm ON posts USING gin (content_md gin_trgm_ops);",
]

# 注销缓冲期（10 天可恢复）：记录申请时间、预计清除时间与删除前的状态
_DELETION_GRACE = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS status_before_deletion VARCHAR(16);",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;",
    "CREATE INDEX IF NOT EXISTS ix_users_status_purge ON users(status, purge_after);",
]

# 隐私细分：允许用户隐藏自己的 IP 属地（默认仍然展示，保持现状不被意外改变）
_PRIVACY_IP_LOCATION = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_ip_location BOOLEAN NOT NULL DEFAULT FALSE;",
]

# 隐私细分：允许用户隐藏自己的在线状态（默认展示，与「默认开」的产品取舍一致）
_PRIVACY_ONLINE_STATUS = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_online_status BOOLEAN NOT NULL DEFAULT FALSE;",
]

# 友情链接：申请/审核与图标重试所需字段（表由 create_all 创建，这里补齐后续新增列）
_FRIEND_LINK_APPLY = [
    "ALTER TABLE friend_links ADD COLUMN IF NOT EXISTS applicant_user_id UUID;",
    "ALTER TABLE friend_links ADD COLUMN IF NOT EXISTS applicant_contact VARCHAR(120) NOT NULL DEFAULT '';",
    "ALTER TABLE friend_links ADD COLUMN IF NOT EXISTS reject_reason VARCHAR(200) NOT NULL DEFAULT '';",
    "ALTER TABLE friend_links ADD COLUMN IF NOT EXISTS icon_checked_at TIMESTAMPTZ;",
    "CREATE INDEX IF NOT EXISTS ix_friend_links_status ON friend_links(status);",
]

# 评论支持单张配图 / 自定义表情
_COMMENT_IMAGE = [
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS image_url VARCHAR(512) NOT NULL DEFAULT '';",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS image_kind VARCHAR(16) NOT NULL DEFAULT '';",
]

# 聊天引用回复：群消息与私聊消息都存「被引用消息 id + 发送者 + 内容快照」
_CHAT_REPLY = [
    "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS reply_to_id UUID;",
    "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS reply_sender VARCHAR(64) NOT NULL DEFAULT '';",
    "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS reply_snippet VARCHAR(200) NOT NULL DEFAULT '';",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id UUID;",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_sender VARCHAR(64) NOT NULL DEFAULT '';",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_snippet VARCHAR(200) NOT NULL DEFAULT '';",
]

# 九宫格多图：帖子支持最多 10 张图，按用户排列顺序存 JSON 数组
_POST_IMAGES = [
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_urls JSONB;",
]

# 群头像：模型早已有 avatar_url，但旧库没有补列，create_all 不会给已存在的表加字段
_GROUP_AVATAR = [
    "ALTER TABLE group_rooms ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(255) NOT NULL DEFAULT '';",
]

# 中文搜索：ilike '%关键词%' 无法走普通 B-Tree，加 pg_trgm 的 GIN 索引后可走索引
_SEARCH_TRGM = [
    "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
    "CREATE INDEX IF NOT EXISTS ix_posts_title_trgm ON posts USING gin (title gin_trgm_ops);",
    "CREATE INDEX IF NOT EXISTS ix_posts_content_trgm ON posts USING gin (content_md gin_trgm_ops);",
    "CREATE INDEX IF NOT EXISTS ix_comments_content_trgm ON comments USING gin (content gin_trgm_ops);",
]

# 补签记录：连续签到达到 5/10/15/25 天各获得 1 次补签机会
_CHECKIN_MAKEUP = [
    """CREATE TABLE IF NOT EXISTS checkin_makeups (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_date DATE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, target_date)
    );""",
    "CREATE INDEX IF NOT EXISTS ix_checkin_makeups_user ON checkin_makeups (user_id);",
]

# 隐藏成就解锁记录（只存“谁解锁了什么”）
_EASTER_EGGS = [
    """CREATE TABLE IF NOT EXISTS user_eggs (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        egg_code VARCHAR(64) NOT NULL,
        unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, egg_code)
    );""",
    "CREATE INDEX IF NOT EXISTS ix_user_eggs_user ON user_eggs (user_id);",
]

# 反馈：支持一张截图 + 反馈者确认（已修复 / 仍复现 / 已收到）
_FEEDBACK_CONFIRM = [
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS image_url VARCHAR(512);",
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS user_confirm VARCHAR(16) NOT NULL DEFAULT '';",
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS user_confirm_at TIMESTAMPTZ;",
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS user_note TEXT;",
]

# 通知列表按「接收者 + 时间倒序」查询，单列索引需要额外排序
_NOTIF_RECENT = [
    "CREATE INDEX IF NOT EXISTS ix_notifications_receiver_created ON notifications (receiver_id, created_at DESC);",
]

# 限时称号（榜单名次，按天过期）+ 免打扰偏好上云
_USER_TITLES = [
    """CREATE TABLE IF NOT EXISTS user_titles (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(64) NOT NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'leaderboard',
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, title, source)
    );""",
    "CREATE INDEX IF NOT EXISTS ix_user_titles_expiry ON user_titles (expires_at);",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS muted_chats JSONB NOT NULL DEFAULT '[]'::jsonb;",
]

# 收藏夹分组 + 敏感词待审队列
_COLLECTION_GROUPS = [
    "ALTER TABLE collections ADD COLUMN IF NOT EXISTS group_name VARCHAR(32) NOT NULL DEFAULT '默认收藏';",
    """CREATE TABLE IF NOT EXISTS sensitive_review_queue (
        id BIGSERIAL PRIMARY KEY,
        post_id UUID NOT NULL,
        author_id UUID NOT NULL,
        title VARCHAR(200) NOT NULL DEFAULT '',
        hits TEXT NOT NULL DEFAULT '',
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        resolved_by UUID,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );""",
    "CREATE INDEX IF NOT EXISTS ix_sensitive_review_status ON sensitive_review_queue (status, created_at DESC);",
]

# 独立收藏夹（可创建空文件夹）
_COLLECTION_FOLDERS = [
    """CREATE TABLE IF NOT EXISTS collection_folders (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(32) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, name)
    );""",
]

# 404 小游戏分数与隐藏成就
_MINIGAMES = [
    """CREATE TABLE IF NOT EXISTS minigame_scores (
        id BIGSERIAL PRIMARY KEY,
        game VARCHAR(24) NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        score INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (game, user_id)
    );""",
    "CREATE INDEX IF NOT EXISTS ix_minigame_game_score ON minigame_scores (game, score DESC);",
]

# 反馈 v2：数据驱动子分区 + 草稿箱 + 撤回 + 日期索引
_FEEDBACK_V2 = [
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS category VARCHAR(32) NOT NULL DEFAULT 'other';",
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;",
    "CREATE INDEX IF NOT EXISTS ix_feedbacks_category ON feedbacks (feedback_type, category);",
    "CREATE INDEX IF NOT EXISTS ix_feedbacks_created ON feedbacks (created_at DESC);",
    """CREATE TABLE IF NOT EXISTS feedback_categories (
        id SERIAL PRIMARY KEY,
        parent_type VARCHAR(16) NOT NULL,
        name VARCHAR(32) NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        UNIQUE (parent_type, name)
    );""",
    """INSERT INTO feedback_categories (parent_type, name, sort) VALUES
        ('feature','界面优化',1), ('feature','功能优化',2), ('feature','其他',9),
        ('bug','界面优化',1), ('bug','功能优化',2), ('bug','其他',9)
       ON CONFLICT (parent_type, name) DO NOTHING;""",
]

# 反馈：两类反馈使用各自不同的子分区（覆盖 v2 的通用三分类）
_FEEDBACK_CATEGORIES_V2 = [
    "DELETE FROM feedback_categories WHERE name IN ('界面优化','功能优化','其他');",
    """INSERT INTO feedback_categories (parent_type, name, sort) VALUES
        ('feature','功能建议',1), ('feature','体验优化',2), ('feature','内容建设',3), ('feature','其他',9),
        ('bug','界面异常',1), ('bug','功能异常',2), ('bug','性能问题',3), ('bug','其他',9)
       ON CONFLICT (parent_type, name) DO NOTHING;""",
]

# 偏好：新页面打开文章，随账号持久化
_USER_PREFS = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS open_post_in_new_tab BOOLEAN NOT NULL DEFAULT FALSE;",
]

# 群公告历史 + 已读确认 + @全体成员计数
_GROUP_ANNOUNCEMENTS = [
    """CREATE TABLE IF NOT EXISTS group_announcements (
        id UUID PRIMARY KEY,
        room_id UUID NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TIMESTAMPTZ,
        deleted_by UUID REFERENCES users(id) ON DELETE SET NULL
    );""",
    "CREATE INDEX IF NOT EXISTS idx_group_announcements_room ON group_announcements(room_id, created_at DESC);",
    """CREATE TABLE IF NOT EXISTS group_announcement_reads (
        id UUID PRIMARY KEY,
        announcement_id UUID NOT NULL REFERENCES group_announcements(id) ON DELETE CASCADE,
        room_id UUID NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_group_announcement_read UNIQUE (announcement_id, user_id)
    );""",
    "CREATE INDEX IF NOT EXISTS idx_group_announcement_reads_user ON group_announcement_reads(room_id, user_id);",
    # @全体成员：记录每条消息是否用了该能力，便于按天统计管理员使用次数
    "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS is_mention_all BOOLEAN NOT NULL DEFAULT FALSE;",
    "CREATE INDEX IF NOT EXISTS idx_group_messages_mention_all ON group_messages(sender_id, created_at) WHERE is_mention_all;",
    "ALTER TABLE group_announcements ALTER COLUMN is_deleted SET DEFAULT FALSE;",
    # 回填：把各群现有的单条置顶公告转成一条历史公告（仅当该群还没有公告记录时执行一次）
    """INSERT INTO group_announcements (id, room_id, content, created_at, is_deleted)
       SELECT gen_random_uuid(), r.id, btrim(r.announcement), COALESCE(r.announcement_updated_at, r.created_at), FALSE
       FROM group_rooms r
       WHERE r.announcement IS NOT NULL AND btrim(r.announcement) <> ''
         AND NOT EXISTS (SELECT 1 FROM group_announcements a WHERE a.room_id = r.id);""",
]

# 举报流程 v2：附图、处置时间、举报人索引与并发去重
_REPORTS_V2 = [
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS image_url VARCHAR(512);",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ;",
    "CREATE INDEX IF NOT EXISTS ix_reports_reporter ON reports (reporter_id, created_at DESC);",
    """CREATE UNIQUE INDEX IF NOT EXISTS uq_reports_pending_per_target
       ON reports (reporter_id, target_type, target_id) WHERE status = 'pending';""",
]

# 404 游戏平台 v1：注册中心 / 赛季积分 / 反作弊凭证 / 对战 / 勋章结算
_GAME_PLATFORM = [
    """CREATE TABLE IF NOT EXISTS game_defs (
        code VARCHAR(32) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        zone VARCHAR(8) NOT NULL DEFAULT 'solo',
        engine VARCHAR(16) NOT NULL DEFAULT 'iframe',
        path VARCHAR(128) NOT NULL DEFAULT '',
        difficulty NUMERIC(4,2) NOT NULL DEFAULT 1.00,
        target_score INTEGER NOT NULL DEFAULT 1000,
        ref_seconds INTEGER NOT NULL DEFAULT 120,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        source_license VARCHAR(64) NOT NULL DEFAULT ''
    );""",
    """INSERT INTO game_defs (code,name,zone,engine,path,difficulty,target_score,ref_seconds,sort_order,source_license,enabled) VALUES
        ('2048','数字迷途','solo','iframe','/flea-games/2048/index.html',1.00,20000,300,1,'MIT huazie/flea-game',TRUE),
        ('dino','恐龙快跑','solo','iframe','/flea-games/dino/index.html',1.20,8000,180,2,'MIT huazie/flea-game',TRUE),
        ('shudu','数独','solo','iframe','/flea-games/shudu/index.html',1.60,9,600,3,'MIT huazie/flea-game',TRUE),
        ('memory','记忆翻牌','solo','iframe','/flea-games/memory/index.html',1.00,20,180,4,'MIT huazie/flea-game',TRUE),
        ('tetris','俄罗斯方块','solo','iframe','/flea-games/tetris/index.html',1.50,10000,600,5,'MIT huazie/flea-game',TRUE),
        ('match3','消消乐','solo','iframe','/flea-games/match3/index.html',1.30,10000,300,6,'MIT huazie/flea-game',TRUE),
        ('sokoban','推箱子','solo','iframe','/flea-games/sokoban/game.html',1.80,30,900,7,'MIT huazie/flea-game',TRUE),
        ('minesweeper','扫雷','solo','iframe','/flea-games/minesweeper/index.html',1.50,50,300,8,'MIT huazie/flea-game',TRUE),
        ('snake','碎片贪吃蛇','solo','react','',1.10,60,180,9,'self',TRUE),
        ('gomoku','五子棋','versus','battle','',2.00,0,0,10,'MIT huazie/flea-game',TRUE),
        ('xiangqi','中国象棋','versus','battle','',2.00,0,0,11,'MIT stringify/ChineseChessOnline',TRUE)
       ON CONFLICT (code) DO NOTHING;""",
    """CREATE TABLE IF NOT EXISTS game_runs (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game VARCHAR(32) NOT NULL,
        seed VARCHAR(64) NOT NULL DEFAULT '',
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        raw_score INTEGER NOT NULL DEFAULT 0,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        difficulty NUMERIC(4,2) NOT NULL DEFAULT 1.00,
        settled BOOLEAN NOT NULL DEFAULT FALSE,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );""",
    "CREATE INDEX IF NOT EXISTS ix_game_runs_user ON game_runs (user_id, started_at DESC);",
    """CREATE TABLE IF NOT EXISTS season_scores (
        id BIGSERIAL PRIMARY KEY,
        season_id VARCHAR(7) NOT NULL,
        game VARCHAR(32) NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        season_score INTEGER NOT NULL DEFAULT 0,
        best_raw INTEGER NOT NULL DEFAULT 0,
        runs INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (season_id, game, user_id)
    );""",
    "CREATE INDEX IF NOT EXISTS ix_season_scores_rank ON season_scores (season_id, game, season_score DESC);",
    """CREATE TABLE IF NOT EXISTS game_points_snapshots (
        id BIGSERIAL PRIMARY KEY,
        season_id VARCHAR(7) NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        total_score NUMERIC(6,2) NOT NULL DEFAULT 0,
        breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
        rank INTEGER NOT NULL DEFAULT 0,
        settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (season_id, user_id)
    );""",
    """CREATE TABLE IF NOT EXISTS season_registry (
        season_id VARCHAR(7) PRIMARY KEY,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,
        settled_at TIMESTAMPTZ,
        status VARCHAR(16) NOT NULL DEFAULT 'active'
    );""",
    """CREATE TABLE IF NOT EXISTS battle_matches (
        id UUID PRIMARY KEY,
        game_code VARCHAR(32) NOT NULL,
        inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invitee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        board_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        move_seq INTEGER NOT NULL DEFAULT 0,
        turn_user_id UUID,
        winner_id UUID,
        result VARCHAR(16),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ
    );""",
    "CREATE INDEX IF NOT EXISTS ix_battle_players ON battle_matches (inviter_id, invitee_id, status);",
    """CREATE TABLE IF NOT EXISTS battle_moves (
        id BIGSERIAL PRIMARY KEY,
        match_id UUID NOT NULL REFERENCES battle_matches(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        actor_id UUID NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (match_id, seq)
    );""",
    """CREATE TABLE IF NOT EXISTS battle_season_stats (
        id BIGSERIAL PRIMARY KEY,
        season_id VARCHAR(7) NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        current_streak INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0,
        UNIQUE (season_id, user_id)
    );""",
    "CREATE INDEX IF NOT EXISTS ix_battle_stats_season ON battle_season_stats (season_id, best_streak DESC, wins DESC);",
    "ALTER TABLE minigame_scores ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();",
]

# 404 游戏平台：新增井字棋（对战）
_TICTACTOE = [
    """INSERT INTO game_defs (code,name,zone,engine,path,difficulty,target_score,ref_seconds,sort_order,source_license,enabled)
       VALUES ('tictactoe','井字棋','versus','battle','',1.00,0,0,12,'self',TRUE)
       ON CONFLICT (code) DO NOTHING;""",
]

# 404 计分 v2：连续区分度 + 并列排序；参考用时下调到各游戏真实量级
_GAME_SCORING = [
    "ALTER TABLE season_scores ADD COLUMN IF NOT EXISTS tiebreak INTEGER NOT NULL DEFAULT 0;",
    "CREATE INDEX IF NOT EXISTS ix_season_scores_tiebreak ON season_scores (season_id, game, tiebreak DESC);",
    """UPDATE game_defs SET ref_seconds = CASE code
         WHEN '2048' THEN 180 WHEN 'dino' THEN 90 WHEN 'shudu' THEN 240
         WHEN 'memory' THEN 60 WHEN 'tetris' THEN 240 WHEN 'match3' THEN 180
         WHEN 'sokoban' THEN 90 WHEN 'minesweeper' THEN 90 WHEN 'snake' THEN 90
         ELSE ref_seconds END
       WHERE zone = 'solo';""",
]

# 群聊增强：禁言 / 独立等级经验 / 铭牌
_GROUP_LEVEL_V1 = [
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS group_exp INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS group_level SMALLINT NOT NULL DEFAULT 1;",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS today_msg_count INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS today_exp_gained INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS today_exp_date DATE;",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS interaction_count INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS heat_score INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS badge_id SMALLINT;",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS mute_reason VARCHAR(200);",
    "CREATE INDEX IF NOT EXISTS ix_group_members_level ON group_members (room_id, group_level DESC);",
]

# 签到按时间段打卡：群配置时间段 + 打卡流水记录命中的时段
_GROUP_CHECKIN_SLOTS = [
    "ALTER TABLE group_rooms ADD COLUMN IF NOT EXISTS checkin_slots JSONB NOT NULL DEFAULT '[]'::jsonb;",
    "ALTER TABLE group_checkins ADD COLUMN IF NOT EXISTS slot_name VARCHAR(16) NOT NULL DEFAULT '';",
]


# 发帖正文格式：Markdown / 纯文本
_POST_CONTENT_TYPE = [
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS content_type VARCHAR(16) NOT NULL DEFAULT 'markdown';",
]

# 群聊自定义名牌：管理员发放文字，成员自己切换等级牌/自定义牌
_GROUP_CUSTOM_BADGE = [
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS custom_badge_name VARCHAR(32);",
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS badge_mode VARCHAR(10) NOT NULL DEFAULT 'level';",
]

# 群签到配置 + 流水表（北京时间自然日，按 occurrence 控制每日 1 / 3 次）
_GROUP_CHECKIN = [
    "ALTER TABLE group_rooms ADD COLUMN IF NOT EXISTS checkin_text VARCHAR(32) NOT NULL DEFAULT 'hhh';",
    "ALTER TABLE group_rooms ADD COLUMN IF NOT EXISTS checkin_times_per_day SMALLINT NOT NULL DEFAULT 1;",
    "ALTER TABLE group_rooms ADD COLUMN IF NOT EXISTS checkin_exp INTEGER NOT NULL DEFAULT 5;",
    """CREATE TABLE IF NOT EXISTS group_checkins (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         room_id UUID NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
         user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         checkin_date DATE NOT NULL,
         occurrence SMALLINT NOT NULL DEFAULT 1,
         exp INTEGER NOT NULL DEFAULT 0,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (room_id, user_id, checkin_date, occurrence)
       );""",
    "CREATE INDEX IF NOT EXISTS ix_group_checkins_day ON group_checkins (room_id, checkin_date);",
]

# AI 管理 / 站点内容 / 好文分享 / 全局打卡配置
_AI_ADMIN_V1 = [
    "ALTER TABLE system_settings ALTER COLUMN value TYPE TEXT;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS source_type VARCHAR(16);",
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS source_note VARCHAR(500);",
    """CREATE TABLE IF NOT EXISTS site_contents (
         key VARCHAR(32) PRIMARY KEY,
         title VARCHAR(200) NOT NULL DEFAULT '',
         content TEXT NOT NULL DEFAULT '',
         updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );""",
    """INSERT INTO site_contents (key, title, content, updated_at)
       SELECT 'legal', '免责与法律声明', '', now() WHERE NOT EXISTS (SELECT 1 FROM site_contents WHERE key='legal');""",
    """INSERT INTO categories (name, slug, description, icon, sort_order)
       SELECT '好文分享', 'share', '转载与原创优质长文', 'BookOpen', 7
       WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug='share');""",
    """INSERT INTO system_settings (key, value, description, updated_at)
       SELECT 'checkin_text', '签到', '群签到语（全局默认，群主可改）', now()
       WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key='checkin_text');""",
    """INSERT INTO system_settings (key, value, description, updated_at)
       SELECT 'checkin_times_per_day', '1', '每日打卡次数（1-3，经验固定 10）', now()
       WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key='checkin_times_per_day');""",
]

# 群签到：默认签到语改为「签到」，单次经验全局固定 10
_CHECKIN_FIXED_EXP = [
    "UPDATE group_rooms SET checkin_exp = 10;",
    "UPDATE group_rooms SET checkin_text = '签到' WHERE checkin_text = 'hhh';",
    "ALTER TABLE group_rooms ALTER COLUMN checkin_exp SET DEFAULT 10;",
    "ALTER TABLE group_rooms ALTER COLUMN checkin_text SET DEFAULT '签到';",
]

# 铭牌 v2：等级铭牌不可授予；特殊名牌独立表（一人多个、可收回）+ AI 评论幂等
_BADGE_V2_PERMS = [
    "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS special_badge_name VARCHAR(32);",
    """CREATE TABLE IF NOT EXISTS group_special_badges (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         room_id UUID NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
         user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         name VARCHAR(32) NOT NULL,
         granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (room_id, user_id, name)
       );""",
    "CREATE INDEX IF NOT EXISTS ix_group_special_badges_user ON group_special_badges (room_id, user_id);",
    """CREATE TABLE IF NOT EXISTS ai_comment_log (
         post_id UUID PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
         comment_id UUID,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );""",
    # 历史自定义名牌迁移成特殊名牌，保持用户已获得的展示不丢
    """INSERT INTO group_special_badges (room_id, user_id, name, granted_by)
       SELECT room_id, user_id, TRIM(custom_badge_name), NULL
       FROM group_members
       WHERE custom_badge_name IS NOT NULL AND TRIM(custom_badge_name) <> ''
       ON CONFLICT (room_id, user_id, name) DO NOTHING;""",
    """UPDATE group_members SET special_badge_name = TRIM(custom_badge_name)
       WHERE custom_badge_name IS NOT NULL AND TRIM(custom_badge_name) <> ''
         AND (badge_mode = 'custom' OR badge_mode IS NULL);""",
]

# AI 评论重试记录：失败次数与原因，连续失败 3 次自动放弃
_AI_COMMENT_RETRY = [
    "ALTER TABLE ai_comment_log ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE ai_comment_log ADD COLUMN IF NOT EXISTS last_error TEXT;",
]

# 修复历史「草稿发布后 0 票」：给已发布但作者没投过票的反馈补上自带 +1 UP
_FEEDBACK_UP_BACKFILL = [
    """INSERT INTO feedback_upvotes (feedback_id, user_id, created_at)
       SELECT f.id, f.user_id, now() FROM feedbacks f
       WHERE f.is_draft = FALSE
         AND NOT EXISTS (
           SELECT 1 FROM feedback_upvotes u
           WHERE u.feedback_id = f.id AND u.user_id = f.user_id
         )
       ON CONFLICT DO NOTHING;""",
    """UPDATE feedbacks f
       SET upvotes_count = GREATEST(f.upvotes_count,
         (SELECT count(*) FROM feedback_upvotes u WHERE u.feedback_id = f.id))
       WHERE f.is_draft = FALSE;""",
]

# 成语接龙 / 每日求签 / 群投票
_GROUP_ACTIVITIES_V1 = [
    """CREATE TABLE IF NOT EXISTS idiom_chain_games (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         room_id UUID NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
         status VARCHAR(16) NOT NULL DEFAULT 'playing',
         state_json JSON NOT NULL DEFAULT '{}'::json,
         created_by UUID REFERENCES users(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         ended_at TIMESTAMPTZ
       );""",
    "CREATE INDEX IF NOT EXISTS ix_idiom_chain_room ON idiom_chain_games (room_id, status);",
    """CREATE TABLE IF NOT EXISTS daily_fortune_draws (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         draw_date VARCHAR(10) NOT NULL,
         occurrence SMALLINT NOT NULL DEFAULT 1,
         tier VARCHAR(16) NOT NULL,
         result_json JSON NOT NULL DEFAULT '{}'::json,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (user_id, draw_date, occurrence)
       );""",
    """CREATE TABLE IF NOT EXISTS group_polls (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         room_id UUID NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
         creator_id UUID REFERENCES users(id) ON DELETE SET NULL,
         title VARCHAR(200) NOT NULL,
         description TEXT,
         is_multiple BOOLEAN NOT NULL DEFAULT FALSE,
         max_choices SMALLINT NOT NULL DEFAULT 1,
         is_anonymous BOOLEAN NOT NULL DEFAULT FALSE,
         expires_at TIMESTAMPTZ NOT NULL,
         closed_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );""",
    """CREATE TABLE IF NOT EXISTS group_poll_options (
         id SERIAL PRIMARY KEY,
         poll_id UUID NOT NULL REFERENCES group_polls(id) ON DELETE CASCADE,
         option_text VARCHAR(200) NOT NULL,
         sort_order SMALLINT NOT NULL DEFAULT 0,
         vote_count INTEGER NOT NULL DEFAULT 0
       );""",
    """CREATE TABLE IF NOT EXISTS group_poll_votes (
         id SERIAL PRIMARY KEY,
         poll_id UUID NOT NULL REFERENCES group_polls(id) ON DELETE CASCADE,
         option_id INTEGER NOT NULL REFERENCES group_poll_options(id) ON DELETE CASCADE,
         user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (poll_id, option_id, user_id)
       );""",
    "CREATE INDEX IF NOT EXISTS ix_group_poll_room ON group_polls (room_id, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS ix_group_poll_votes ON group_poll_votes (poll_id);",
    "ALTER TABLE group_messages ALTER COLUMN msg_type TYPE VARCHAR(24);",
]

# 飞花令：单局状态表（词库 poetry.db 为只读静态文件，不走数据库迁移）
_FEIHUA_V1 = [
    """CREATE TABLE IF NOT EXISTS feihua_games (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         room_id UUID NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
         status VARCHAR(16) NOT NULL DEFAULT 'playing',
         flag VARCHAR(8),
         state_json JSON NOT NULL DEFAULT '{}'::json,
         created_by UUID REFERENCES users(id) ON DELETE SET NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         ended_at TIMESTAMPTZ
       );""",
    "CREATE INDEX IF NOT EXISTS ix_feihua_room ON feihua_games (room_id, status);",
    "CREATE INDEX IF NOT EXISTS ix_feihua_flag ON feihua_games (flag);",
]

# 问答广场：新分区 + 悬赏状态表 + 经验流水 + 系统经验池
_QA_PLAZA_V1 = [
    """INSERT INTO categories (name, slug, description, icon, sort_order)
       SELECT '问答广场', 'qa', '提问与悬赏采纳，7 天采纳期', 'HelpCircle', 8
       WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug='qa');""",
    """CREATE TABLE IF NOT EXISTS qa_questions (
         post_id UUID PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
         asker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         bounty INTEGER NOT NULL DEFAULT 10,
         status VARCHAR(16) NOT NULL DEFAULT 'pending',
         expires_at TIMESTAMPTZ NOT NULL,
         settled_at TIMESTAMPTZ,
         accepted_count INTEGER NOT NULL DEFAULT 0,
         remainder INTEGER NOT NULL DEFAULT 0,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );""",
    "CREATE INDEX IF NOT EXISTS ix_qa_questions_status ON qa_questions (status, expires_at);",
    "CREATE INDEX IF NOT EXISTS ix_qa_questions_asker ON qa_questions (asker_id, created_at);",
    """CREATE TABLE IF NOT EXISTS exp_ledger (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id UUID REFERENCES users(id) ON DELETE CASCADE,
         amount INTEGER NOT NULL,
         direction VARCHAR(16) NOT NULL,
         reason VARCHAR(64) NOT NULL,
         post_id UUID,
         comment_id UUID,
         idempotency_key VARCHAR(160) UNIQUE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );""",
    "CREATE INDEX IF NOT EXISTS ix_exp_ledger_post ON exp_ledger (post_id);",
    "CREATE INDEX IF NOT EXISTS ix_exp_ledger_comment ON exp_ledger (comment_id);",
    "CREATE INDEX IF NOT EXISTS ix_exp_ledger_reason ON exp_ledger (reason);",
    """CREATE TABLE IF NOT EXISTS qa_extra_quota (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         day VARCHAR(10) NOT NULL,
         source VARCHAR(16) NOT NULL DEFAULT 'exchange',
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );""",
    "CREATE INDEX IF NOT EXISTS ix_qa_extra_quota ON qa_extra_quota (user_id, day);",
    """INSERT INTO system_settings (key, value, description, updated_at)
       SELECT 'qa_exp_pool', '1000000', '问答悬赏系统经验池（虚拟账本）', now()
       WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key='qa_exp_pool');""",
    """INSERT INTO system_settings (key, value, description, updated_at)
       SELECT 'qa_daily_question_limit', '1', '普通用户每自然日可发布的问题数', now()
       WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key='qa_daily_question_limit');""",
    """INSERT INTO system_settings (key, value, description, updated_at)
       SELECT 'qa_bounty_amount', '10', '每个问题默认绑定的悬赏经验', now()
       WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key='qa_bounty_amount');""",
    # 回答登记表：唯一约束保证「单用户对单问题只能有 1 个回答」，并发安全
    """CREATE TABLE IF NOT EXISTS qa_answers (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
         author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         comment_id UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         UNIQUE (post_id, author_id)
       );""",
    "CREATE INDEX IF NOT EXISTS ix_qa_answers_post ON qa_answers (post_id);",
]

# 反馈截图改为最多 5 张（保留旧 image_url 列兼容历史数据）
_FEEDBACK_MULTI_IMAGES = [
    "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS image_urls JSONB;",
]

# 默认门户界面偏好：随账号持久化，默认经典版
_PORTAL_MODE = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS portal_mode VARCHAR(16) NOT NULL DEFAULT 'classic';",
]

MIGRATIONS: list[tuple[str, list[str]]] = [
    ("20261030_baseline", _BASELINE),
    ("20261031_deletion_grace", _DELETION_GRACE),
    ("20261104_privacy_ip_location", _PRIVACY_IP_LOCATION),
    ("20261104_privacy_online_status", _PRIVACY_ONLINE_STATUS),
    ("20261104_friend_link_apply", _FRIEND_LINK_APPLY),
    ("20261104_comment_image", _COMMENT_IMAGE),
    ("20261105_chat_reply", _CHAT_REPLY),
    ("20261107_post_images", _POST_IMAGES),
    ("20261107_group_avatar", _GROUP_AVATAR),
    ("20261107_notif_recent_idx", _NOTIF_RECENT),
    ("20261107_feedback_confirm", _FEEDBACK_CONFIRM),
    ("20261108_search_trgm", _SEARCH_TRGM),
    ("20261108_easter_eggs", _EASTER_EGGS),
    ("20261108_checkin_makeup", _CHECKIN_MAKEUP),
    ("20261108_user_titles", _USER_TITLES),
    ("20261108_collection_groups", _COLLECTION_GROUPS),
    ("20261108_collection_folders", _COLLECTION_FOLDERS),
    ("20261108_minigames", _MINIGAMES),
    ("20261109_feedback_v2", _FEEDBACK_V2),
    ("20261109_feedback_categories_v2", _FEEDBACK_CATEGORIES_V2),
    ("20261109_user_prefs", _USER_PREFS),
    ("20261110_group_announcements", _GROUP_ANNOUNCEMENTS),
    ("20261110_reports_v2", _REPORTS_V2),
    ("20261110_game_platform", _GAME_PLATFORM),
    ("20261110_tictactoe", _TICTACTOE),
    ("20261111_game_scoring", _GAME_SCORING),
    ("20261111_group_level_v1", _GROUP_LEVEL_V1),
    ("20261116_group_checkin_slots", _GROUP_CHECKIN_SLOTS),
    ("20261111_post_content_type", _POST_CONTENT_TYPE),
    ("20261111_group_custom_badge", _GROUP_CUSTOM_BADGE),
    ("20261111_group_checkin", _GROUP_CHECKIN),
    ("20261112_ai_admin_v1", _AI_ADMIN_V1),
    ("20261112_checkin_fixed_exp", _CHECKIN_FIXED_EXP),
    ("20261112_badge_v2_perms", _BADGE_V2_PERMS),
    ("20261112_ai_comment_retry", _AI_COMMENT_RETRY),
    ("20261112_feedback_up_backfill", _FEEDBACK_UP_BACKFILL),
    ("20261112_group_activities_v1", _GROUP_ACTIVITIES_V1),
    ("20261112_qa_plaza_v1", _QA_PLAZA_V1),
    ("20261113_feedback_multi_images", _FEEDBACK_MULTI_IMAGES),
    ("20261115_portal_mode", _PORTAL_MODE),
    ("20261118_feihua_v1", _FEIHUA_V1),
    ("20261119_battle_history_visibility", [
        "ALTER TABLE battle_matches ADD COLUMN IF NOT EXISTS inviter_hidden_at TIMESTAMPTZ;",
        "ALTER TABLE battle_matches ADD COLUMN IF NOT EXISTS invitee_hidden_at TIMESTAMPTZ;",
    ]),
    ("20261119_post_album_quota", ["ALTER TABLE posts ADD COLUMN IF NOT EXISTS album_quota_at TIMESTAMPTZ;"]),
    # 管理员在用户管理页执行重置后，额外发放 1 次昵称修改额度
    ("20261120_nickname_extra_quota", [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname_extra_quota INTEGER NOT NULL DEFAULT 0;",
    ]),
]


async def ensure_schema(engine: AsyncEngine, metadata) -> None:
    """串行化建表：双 worker 首次启动时并发 create_all 可能撞出 duplicate table。"""
    async with engine.connect() as lock_conn:
        await lock_conn.execute(text("SELECT pg_advisory_lock(:k);"), {"k": _MIGRATION_LOCK_KEY})
        try:
            async with engine.begin() as conn:
                await conn.run_sync(metadata.create_all)
        finally:
            await lock_conn.execute(text("SELECT pg_advisory_unlock(:k);"), {"k": _MIGRATION_LOCK_KEY})


async def run_migrations(engine: AsyncEngine) -> None:
    """应用所有未执行过的迁移；多实例并发启动时通过咨询锁串行。"""
    # 版本表本身用独立事务创建，避免被后续语句的失败回滚
    async with engine.begin() as conn:
        await conn.execute(text(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version VARCHAR(64) PRIMARY KEY,"
            "applied_at TIMESTAMPTZ NOT NULL DEFAULT now()"
            ");"
        ))

    async with engine.connect() as lock_conn:
        await lock_conn.execute(text("SELECT pg_advisory_lock(:k);"), {"k": _MIGRATION_LOCK_KEY})
        try:
            applied = set()
            result = await lock_conn.execute(text("SELECT version FROM schema_migrations;"))
            for row in result.fetchall():
                applied.add(row[0])

            for version, statements in MIGRATIONS:
                if version in applied:
                    continue

                failures = 0
                for stmt in statements:
                    try:
                        async with engine.begin() as conn:
                            await conn.execute(text(stmt))
                    except Exception as exc:  # 历史脏数据可能导致索引创建失败，记录后继续
                        failures += 1
                        print(f"[Migration:{version}] 语句跳过 ({str(exc).splitlines()[0][:120]}) -> {stmt[:80]}")

                if failures:
                    # 关键：只要有语句失败就不能标记版本完成，
                    # 否则旧库永久缺列/缺索引，且重启也不会重试。
                    print(f"[Migration][ERROR] {version} 有 {failures} 条语句失败，本次不标记完成，下次启动将重试")
                    continue

                async with engine.begin() as conn:
                    await conn.execute(
                        text("INSERT INTO schema_migrations (version) VALUES (:v) ON CONFLICT DO NOTHING;"),
                        {"v": version},
                    )
                print(f"[Migration] 已应用 {version}")
        finally:
            await lock_conn.execute(text("SELECT pg_advisory_unlock(:k);"), {"k": _MIGRATION_LOCK_KEY})

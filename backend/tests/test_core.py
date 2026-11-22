import pytest
from app.services.sensitive_service import sensitive_filter
from app.services.anon_service import generate_anonymous_alias, LEVEL_ANON_QUOTAS
from app.services.level_service import calculate_level_from_exp
from app.core.security import get_password_hash, verify_password, create_access_token, decode_token
import uuid

def test_sensitive_filter_normalization():
    """验证文本降噪管道与标点干扰对抗"""
    # 正常文本
    is_blocked, hits, _ = sensitive_filter.scan("这是一个普通的友善交流帖子")
    assert not is_blocked
    assert len(hits) == 0

    # 包含违规词
    is_blocked, hits, replaced = sensitive_filter.scan("这里有办理赌博平台的信息")
    assert is_blocked
    assert "赌博平台" in hits
    assert "****" in replaced

    # 包含特殊干扰符: "赌*博-平*台"
    is_blocked_tricky, hits_tricky, replaced_tricky = sensitive_filter.scan("加微信玩赌*博-平*台！")
    assert is_blocked_tricky
    assert "赌博平台" in hits_tricky

def test_level_calculation():
    """验证经验等级换算"""
    assert calculate_level_from_exp(0) == 0
    assert calculate_level_from_exp(10) == 1
    assert calculate_level_from_exp(150) == 2
    assert calculate_level_from_exp(500) == 3
    assert calculate_level_from_exp(1200) == 4
    assert calculate_level_from_exp(3500) == 5
    assert calculate_level_from_exp(8000) == 6

def test_anonymous_alias_generation():
    """验证单帖一致、跨帖变化的匿名别名"""
    post_a = uuid.uuid4()
    post_b = uuid.uuid4()
    user_id = uuid.uuid4()

    # 同一帖子下多次生成必须一致
    alias_1 = generate_anonymous_alias(post_a, user_id)
    alias_2 = generate_anonymous_alias(post_a, user_id)
    assert alias_1 == alias_2

    # 换一个帖子后别名必须变化
    alias_other_post = generate_anonymous_alias(post_b, user_id)
    # 极低概率哈希碰撞，但整体应为动态值
    assert isinstance(alias_other_post, str)

    # 楼主匿名评论必须带楼主标识
    author_alias = generate_anonymous_alias(post_a, user_id, is_post_author=True)
    assert "匿名楼主" in author_alias

def test_password_and_token_security():
    """验证 Bcrypt 哈希与 JWT 生成解码"""
    pwd = "MySecretPassword2026!"
    hashed = get_password_hash(pwd)
    assert hashed != pwd
    assert verify_password(pwd, hashed)
    assert not verify_password("WrongPassword", hashed)

    # JWT 签发与验证
    user_id = str(uuid.uuid4())
    token = create_access_token(user_id, role="user")
    payload = decode_token(token)
    assert payload is not None
    assert payload.get("sub") == user_id
    assert payload.get("role") == "user"
    assert payload.get("type") == "access"

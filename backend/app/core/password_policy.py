"""密码强度策略（仅约束「新设置的密码」，不影响存量用户登录）

设计取舍：
- 只在新注册 / 改密 / 重置密码时校验，登录永远只做哈希比对，
  因此规则收紧后老用户照常用原密码登录，不会被动锁在门外；
- 规则面向普通用户而非安全专家，所以只保留三条硬性要求
  （长度、字母+数字、非常见弱口令），避免出现"为了合规把用户逼走"的情况。
"""

import re

# 仅允许可见 ASCII 且不含空格：bcrypt 只取前 72 字节，
# 限制在 ASCII 内可以保证长度语义与字节数一致，也不会出现中文/Emoji 的编码歧义
PASSWORD_PATTERN = r"^[\x21-\x7E]+$"

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_BYTES = 72

# 常见弱口令（小写比较）。不追求覆盖全部泄露库，只拦最容易被撞库扫到的那批；
# 后续如需更强防护，可换成 HIBP k-anonymity 在线校验。
WEAK_PASSWORDS = {
    "password", "password1", "password12", "password123", "passw0rd", "p@ssw0rd",
    "12345678", "123456789", "1234567890", "12345678910", "123123123", "11111111",
    "00000000", "88888888", "66666666", "12341234", "11223344", "87654321",
    "qwertyui", "qwerty123", "qwertyuiop", "qwerty1234", "1qaz2wsx", "1qaz2wsx3edc",
    "zaq12wsx", "asdfghjk", "asdf1234", "zxcvbnm1", "abc12345", "abcd1234",
    "a1234567", "a12345678", "aa123456", "abc123456", "admin123", "admin1234",
    "admin888", "root1234", "test1234", "test12345", "guest123", "welcome1",
    "welcome123", "iloveyou1", "iloveyou", "letmein1", "sunshine1", "princess1",
    "football1", "baseball1", "superman1", "starwars1", "whatever1", "trustno1",
    "qazwsxedc", "1q2w3e4r", "1q2w3e4r5t", "qweasdzxc", "qwe123!@#", "asd123!@#",
    "woaini1314", "woaini520", "5201314520", "13145201314", "a123456789",
    "xiaoming123", "zhang123", "wang123456", "li12345678",
}

WEAK_PATTERNS = (
    re.compile(r"^(.)\1+$"),            # 全同一字符：aaaaaaaa / 11111111
    re.compile(r"^(0123|1234|2345|3456|4567|5678|6789|7890|abcd|qwer|asdf|zxcv)"),
)


def validate_password_strength(v: str) -> str:
    """校验新密码强度，不通过时抛出中文 ValueError（FastAPI 会转成 422 的 detail）。"""
    password = v or ""

    if not re.fullmatch(PASSWORD_PATTERN, password):
        raise ValueError("密码仅支持不含空格的英文、数字与英文符号，不支持中文或其他非 ASCII 字符")
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise ValueError("密码过长（超过 72 字节），请缩短后重试")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"密码长度至少 {MIN_PASSWORD_LENGTH} 位")

    has_letter = bool(re.search(r"[A-Za-z]", password))
    has_digit = bool(re.search(r"\d", password))
    if not (has_letter and has_digit):
        raise ValueError("密码需同时包含字母和数字")

    lowered = password.lower()
    if lowered in WEAK_PASSWORDS or any(p.match(lowered) for p in WEAK_PATTERNS):
        raise ValueError("这个密码太常见了，换一个更难猜的")

    return v


def validate_password_against_identity(password: str, username: str = "", email: str = "") -> None:
    """拦截「密码里直接包含用户名/邮箱前缀」这种最容易被人猜到的组合。

    调用方拿得到身份信息时再调（注册、已登录改密），单独改密接口可以不调。
    """
    candidate = (password or "").lower()
    if not candidate:
        return

    idents = []
    if username and len(username.strip()) >= 3:
        idents.append(username.strip().lower())
    if email and "@" in email:
        local = email.split("@", 1)[0].strip().lower()
        if len(local) >= 3:
            idents.append(local)

    for ident in idents:
        if ident in candidate:
            raise ValueError("密码不能包含用户名或邮箱前缀")

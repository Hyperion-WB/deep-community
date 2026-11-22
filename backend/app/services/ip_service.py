import urllib.request
import json
import ipaddress
import re

# 内存 IP 地理位置缓存，避免重复外呼查询
_IP_LOCATION_CACHE: dict[str, str] = {}

def clean_location_string(raw: str) -> str:
    """标准化中文属地显示名称"""
    if not raw:
        return ""
    # 剥离运营商及机房网络等后缀
    cleaned = re.sub(r'(电信|联通|移动|铁通|广电|阿里云|腾讯云|华为云|百度云|BGP|机房|网络|数据中心).*$', '', raw).strip()
    cleaned = re.sub(r'(.+省)\1', r'\1', cleaned)
    cleaned = re.sub(r'(.+市)\1', r'\1', cleaned)
    
    # 提取核心区域或省份
    m = re.match(r'^([^省市区]+(?:省|自治区|特别行政区|市))', cleaned)
    if m:
        core = m.group(1)
        for suffix in ["省", "市", "维吾尔", "壮族", "回族", "自治区", "特别行政区"]:
            core = core.replace(suffix, "")
        return core or cleaned
    return cleaned or raw

def extract_client_ip(headers: dict, client_host: str = "") -> str:
    """
    安全提取客户端真实 IP：
    优先按规范解析 X-Forwarded-For 链，过滤掉内网和反向代理 IP；
    次优读取 X-Real-IP；最后降级到 client.host。
    """
    # nginx 用 $remote_addr 覆盖写入 X-Real-IP，客户端无法伪造；
    # X-Forwarded-For 可被客户端追加伪造，仅在缺少 X-Real-IP 时才解析。
    real_ip_first = (headers.get("x-real-ip") or "").strip()
    if real_ip_first:
        return real_ip_first

    forwarded = headers.get("x-forwarded-for") or ""
    if forwarded:
        ips = [ip.strip() for ip in forwarded.split(",") if ip.strip()]
        for ip in ips:
            try:
                ip_obj = ipaddress.ip_address(ip)
                if not ip_obj.is_private and not ip_obj.is_loopback:
                    return ip
            except Exception:
                continue
        if ips:
            return ips[0]

    real_ip = headers.get("x-real-ip") or ""
    if real_ip:
        return real_ip.strip()

    return client_host or ""

def resolve_ip_location(ip: str) -> str:
    """
    根据 IP 地址智能查询物理属地（如：江苏、北京、韩国、美国、本地网络）：
    1. 局域网/回环地址直接返回“本地网络”
    2. 命中内存缓存直接毫秒级返回
    3. 优先请求百度公开 IP 接口（免 key、高并发、国内响应迅速）
    """
    if not ip or ip in ("127.0.0.1", "::1", "localhost"):
        return "本地网络"

    if ip in _IP_LOCATION_CACHE:
        return _IP_LOCATION_CACHE[ip]

    try:
        ip_obj = ipaddress.ip_address(ip)
        if ip_obj.is_private or ip_obj.is_loopback:
            return "本地网络"
    except Exception:
        pass

    try:
        # 使用直连 opener，避免被系统全局代理环境变量阻断
        handler = urllib.request.ProxyHandler({})
        opener = urllib.request.build_opener(handler)
        url = f"https://opendata.baidu.com/api.php?query={ip}&co=&resource_id=6006&oe=utf8"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with opener.open(req, timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("data") and len(data["data"]) > 0:
                raw_loc = data["data"][0].get("location", "")
                loc = clean_location_string(raw_loc)
                if loc:
                    _IP_LOCATION_CACHE[ip] = loc
                    return loc
    except Exception:
        pass

    return "未知属地"

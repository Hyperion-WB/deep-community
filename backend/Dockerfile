FROM python:3.11-slim

WORKDIR /app

# 设置时区与避免 Python 输出缓冲
ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# 替换 Debian 软件源为阿里云镜像站 (经实测国内服务器稳定性与下载速度最高)
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list 2>/dev/null || true

# 安装系统依赖 (编译 asyncpg/pillow 等)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 配置 pip 国内镜像源 (阿里云主源，清华/华为备用源，信任对应 Host 避免 SSL 偶发握手失败)
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/ && \
    pip config set global.extra-index-url "https://pypi.tuna.tsinghua.edu.cn/simple/ https://repo.huaweicloud.com/repository/pypi/simple/" && \
    pip config set global.trusted-host "mirrors.aliyun.com pypi.tuna.tsinghua.edu.cn repo.huaweicloud.com"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# 默认 2 个 worker：启动迁移/种子注入已用 PostgreSQL 咨询锁串行化，
# 定时任务用 Redis 锁互斥，WebSocket 通过 Redis Pub/Sub 跨进程投递。
# 内存紧张时可通过 UVICORN_WORKERS=1 回退。
ENV UVICORN_WORKERS=2
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-2} --proxy-headers --forwarded-allow-ips=*"]

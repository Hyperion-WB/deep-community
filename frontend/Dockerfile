# ==============================================================================
# 阶段 1: 前端构建环境 (使用 npmmirror 国内镜像加速)
# ==============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# 构建期堆上限：256MB 在依赖增多后会 OOM（Ineffective mark-compacts），
# 4GB 机器给到 768MB 更稳妥；仍低于整机内存，不会影响后端运行。
ENV NODE_OPTIONS="--max-old-space-size=768"

# 设置 npm 国内镜像源
RUN npm config set registry https://registry.npmmirror.com

# 先复制依赖定义文件利用 Docker 层级缓存
COPY package.json package-lock.json ./
RUN npm install --registry=https://registry.npmmirror.com

# 拷贝前端源代码并执行生产环境编译
COPY . .
RUN npm run build

# ==============================================================================
# 阶段 2: 生产 Nginx 托管环境 (使用清华大学镜像加速)
# ==============================================================================
FROM nginx:1.25-alpine

# 替换 Alpine apk 为国内清华镜像源
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apk/repositories 2>/dev/null || true

WORKDIR /var/www/html

# 从编译阶段拷贝生产静态资源
COPY --from=builder /app/dist /var/www/html

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]

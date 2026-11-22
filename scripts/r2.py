#!/usr/bin/env python3
"""R2 / S3 对象操作小工具。

在 backend 容器内运行（凭据来自容器环境变量），供备份、回档、回收站脚本调用。
用法:
  python r2.py put   <key>                 # stdin -> 对象
  python r2.py get   <key>                 # 对象 -> stdout
  python r2.py list  [prefix]              # 列出对象, 每行: key<TAB>字节<TAB>时间
  python r2.py copy  <src-key> <dst-key>   # 桶内复制
  python r2.py rm    <key>                 # 删除单个对象
  python r2.py prune --prefix P --days N   # 删除 P 前缀下超过 N 天的对象
可选: --bucket <name> 覆盖默认桶（默认取 S3_BACKUP_BUCKET 或 community-backup）
"""
import argparse
import datetime
import os
import sys

import boto3
from botocore.config import Config

DEFAULT_BUCKET = os.environ.get("S3_BACKUP_BUCKET") or "community-backup"


def make_client(bucket=None):
    return boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        region_name=os.environ.get("S3_REGION") or "auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_put = sub.add_parser("put")
    p_put.add_argument("key")

    p_get = sub.add_parser("get")
    p_get.add_argument("key")

    p_list = sub.add_parser("list")
    p_list.add_argument("prefix", nargs="?", default="")

    p_copy = sub.add_parser("copy")
    p_copy.add_argument("src")
    p_copy.add_argument("dst")

    p_rm = sub.add_parser("rm")
    p_rm.add_argument("key")

    p_prune = sub.add_parser("prune")
    p_prune.add_argument("--prefix", required=True)
    p_prune.add_argument("--days", type=int, required=True)

    args = parser.parse_args()
    s3 = make_client()
    bucket = args.bucket

    if args.cmd == "put":
        s3.upload_fileobj(sys.stdin.buffer, bucket, args.key)
        print(f"uploaded: {args.key}", file=sys.stderr)

    elif args.cmd == "get":
        s3.download_fileobj(bucket, args.key, sys.stdout.buffer)
        sys.stdout.buffer.flush()

    elif args.cmd == "list":
        token = None
        while True:
            kw = {"Bucket": bucket, "Prefix": args.prefix, "MaxKeys": 1000}
            if token:
                kw["ContinuationToken"] = token
            resp = s3.list_objects_v2(**kw)
            for item in resp.get("Contents", []):
                ts = item["LastModified"].strftime("%Y-%m-%d %H:%M:%S")
                print(f"{item['Key']}\t{item['Size']}\t{ts}")
            if not resp.get("IsTruncated"):
                break
            token = resp.get("NextContinuationToken")

    elif args.cmd == "copy":
        s3.copy_object(Bucket=bucket, Key=args.dst, CopySource={"Bucket": bucket, "Key": args.src})
        print(f"copied: {args.src} -> {args.dst}", file=sys.stderr)

    elif args.cmd == "rm":
        s3.delete_object(Bucket=bucket, Key=args.key)
        print(f"deleted: {args.key}", file=sys.stderr)

    elif args.cmd == "prune":
        cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=args.days)
        removed = 0
        token = None
        while True:
            kw = {"Bucket": bucket, "Prefix": args.prefix, "MaxKeys": 1000}
            if token:
                kw["ContinuationToken"] = token
            resp = s3.list_objects_v2(**kw)
            batch = []
            for item in resp.get("Contents", []):
                if item["LastModified"] < cutoff:
                    batch.append({"Key": item["Key"]})
            if batch:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": batch, "Quiet": True})
                removed += len(batch)
            if not resp.get("IsTruncated"):
                break
            token = resp.get("NextContinuationToken")
        print(f"pruned: {removed} 个对象 (prefix={args.prefix}, >{args.days}天)", file=sys.stderr)


if __name__ == "__main__":
    main()

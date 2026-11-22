import asyncio
import json
import uuid
from typing import Dict, Iterable, Optional, Set
from fastapi import WebSocket

# 多实例事件总线频道名：所有 worker 订阅同一频道，实现跨进程消息投递
FANOUT_CHANNEL = "wb:ws:fanout"


class ConnectionManager:
    """生产级 WebSocket 连接池管理器

    - active_connections: user_id -> Set[WebSocket]（同账号多端在线）
    - subscriptions: room_id -> Set[user_id]（正在浏览某个公开频道的用户，用于定向推送）
    - 配置了外部 Redis 时自动开启 Pub/Sub 事件桥接，多 worker / 多副本部署可互通
    """

    def __init__(self):
        self.active_connections: Dict[str, Set[WebSocket]] = {}
        self.subscriptions: Dict[str, Set[str]] = {}
        self.instance_id = uuid.uuid4().hex
        self._redis = None
        self._fanout_task: Optional[asyncio.Task] = None

    # ---------- 连接生命周期 ----------
    async def connect(self, user_id: str, websocket: WebSocket, subprotocol: Optional[str] = None):
        await websocket.accept(subprotocol=subprotocol)
        self.active_connections.setdefault(user_id, set()).add(websocket)

    def disconnect(self, user_id: str, websocket: WebSocket):
        if user_id in self.active_connections:
            self.active_connections[user_id].discard(websocket)
            if not self.active_connections[user_id]:
                del self.active_connections[user_id]
                # 该用户已完全离线，清理其房间订阅，避免订阅集合无限膨胀
                for room_id in list(self.subscriptions.keys()):
                    self.subscriptions[room_id].discard(user_id)
                    if not self.subscriptions[room_id]:
                        del self.subscriptions[room_id]

    def is_online(self, user_id: str) -> bool:
        return user_id in self.active_connections and len(self.active_connections[user_id]) > 0

    # ---------- 房间订阅（公开频道定向推送） ----------
    def subscribe(self, user_id: str, room_id: str):
        if not user_id or not room_id:
            return
        self.subscriptions.setdefault(str(room_id), set()).add(str(user_id))

    def unsubscribe(self, user_id: str, room_id: str):
        subs = self.subscriptions.get(str(room_id))
        if subs:
            subs.discard(str(user_id))
            if not subs:
                del self.subscriptions[str(room_id)]

    def unsubscribe_all(self, user_id: str, except_room_id: Optional[str] = None):
        for room_id in list(self.subscriptions.keys()):
            if except_room_id and room_id == str(except_room_id):
                continue
            self.subscriptions[room_id].discard(str(user_id))
            if not self.subscriptions[room_id]:
                del self.subscriptions[room_id]

    def room_subscribers(self, room_id: str) -> Set[str]:
        return set(self.subscriptions.get(str(room_id), set()))

    # ---------- 多实例事件桥接 ----------
    async def start_fanout(self, redis_client):
        """启用跨实例广播（仅在配置了真实 Redis 时生效，内存 Mock 自动跳过）"""
        if redis_client is None or not hasattr(redis_client, "pubsub"):
            return
        self._redis = redis_client
        if self._fanout_task and not self._fanout_task.done():
            return
        self._fanout_task = asyncio.create_task(self._listen_fanout())

    async def stop_fanout(self):
        if self._fanout_task:
            self._fanout_task.cancel()
            try:
                await self._fanout_task
            except (asyncio.CancelledError, Exception):
                pass
            self._fanout_task = None
        self._redis = None

    async def _listen_fanout(self):
        while True:
            try:
                pubsub = self._redis.pubsub()
                await pubsub.subscribe(FANOUT_CHANNEL)
                async for raw in pubsub.listen():
                    if raw.get("type") != "message":
                        continue
                    try:
                        data = json.loads(raw["data"])
                    except (ValueError, TypeError, KeyError):
                        continue
                    # 自己发出的帧本地已投递过，跳过避免重复
                    if data.get("origin") == self.instance_id:
                        continue
                    targets = data.get("targets")
                    payload = data.get("payload")
                    if isinstance(payload, dict):
                        await self._deliver_local(payload, targets)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # Redis 断连后自动重试订阅
                print(f"[WS Fanout] 订阅中断，2 秒后重试: {exc}")
                await asyncio.sleep(2)

    async def _publish(self, message: dict, targets: Optional[Iterable[str]]):
        if not self._redis:
            return
        try:
            await self._redis.publish(FANOUT_CHANNEL, json.dumps({
                "origin": self.instance_id,
                "targets": list(targets) if targets is not None else None,
                "payload": message
            }, ensure_ascii=False))
        except Exception:
            pass

    async def _deliver_local(self, message: dict, targets: Optional[Iterable[str]] = None):
        """仅投递给本进程内的连接；targets=None 表示广播给本进程全部在线连接"""
        payload_str = json.dumps(message, ensure_ascii=False)
        if targets is None:
            user_ids = list(self.active_connections.keys())
        else:
            user_ids = [str(t) for t in set(targets)]

        for user_id in user_ids:
            sockets = self.active_connections.get(user_id)
            if not sockets:
                continue
            dead_sockets = set()
            for ws in list(sockets):
                try:
                    await ws.send_text(payload_str)
                except Exception:
                    dead_sockets.add(ws)
            for dead in dead_sockets:
                sockets.discard(dead)
                if user_id in self.active_connections and not self.active_connections[user_id]:
                    del self.active_connections[user_id]

    # ---------- 对外发送接口 ----------
    async def send_personal_message(self, message: dict, user_id: str):
        """向指定用户的所有在线终端发送消息（含跨实例投递）"""
        uid = str(user_id)
        await self._deliver_local(message, [uid])
        await self._publish(message, [uid])

    async def send_to_users(self, message: dict, user_ids):
        """向一批用户的所有在线终端发送同一消息 (群聊定向推送)"""
        targets = [str(u) for u in set(user_ids)]
        if not targets:
            return
        await self._deliver_local(message, targets)
        await self._publish(message, targets)

    async def broadcast_typing(self, sender_id: str, receiver_id: str, conversation_id: str):
        """向接收方广播输入中状态"""
        await self.send_personal_message({
            "type": "typing",
            "conversation_id": conversation_id,
            "sender_id": sender_id
        }, receiver_id)

    async def broadcast_recall(self, user_a: str, user_b: str, conversation_id: str, message_id: str):
        """向双方广播消息撤回"""
        msg = {
            "type": "recall",
            "conversation_id": conversation_id,
            "message_id": message_id
        }
        await self.send_personal_message(msg, user_a)
        await self.send_personal_message(msg, user_b)

    async def broadcast_group_recall(self, room_id: str, message_id: str, operator_name: str = ""):
        """向全网或群聊广播群消息撤回"""
        await self.broadcast_all({
            "type": "group_recall",
            "room_id": room_id,
            "message_id": message_id,
            "operator_name": operator_name
        })

    async def broadcast_all(self, message: dict):
        """向所有当前在线的连接广播（仅用于全站系统级通告）"""
        await self._deliver_local(message, None)
        await self._publish(message, None)


ws_manager = ConnectionManager()

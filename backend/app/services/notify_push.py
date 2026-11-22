"""通知实时推送：把「有新通知」这个事实通过 WebSocket 推给在线用户。

只推轻量提示，不推完整通知体：
前端收到后自己刷一次未读数（本来就有这个接口），
既保证实时，又不用维护另一套通知序列化逻辑。
"""

import logging

from app.services.ws_manager import ws_manager

logger = logging.getLogger(__name__)


async def push_notification_hint(receiver_id, action_type: str = "", brief: str = "") -> None:
    if not receiver_id:
        return
    try:
        await ws_manager.send_personal_message(
            {
                "type": "notification",
                "action_type": action_type,
                "brief": (brief or "")[:80],
            },
            str(receiver_id),
        )
    except Exception as exc:  # 推送失败绝不能影响主流程
        logger.debug("通知推送失败 receiver=%s err=%s", receiver_id, exc)


async def push_notification_hints(receiver_ids, action_type: str = "", brief: str = "") -> None:
    seen = set()
    for uid in receiver_ids or []:
        if not uid or uid in seen:
            continue
        seen.add(uid)
        await push_notification_hint(uid, action_type, brief)

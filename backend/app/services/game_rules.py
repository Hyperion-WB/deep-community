"""回合制棋类规则引擎（服务端权威）。

三款棋类共用同一套 battle_matches 外壳，只插入不同的规则实现：
  - GomokuRules  15×15 五子棋
  - XiangqiRules 9×10 中国象棋
  - TicTacToeRules 3×3 井字棋

board_state 统一存 JSON：{"cells": {"x,y": piece}, "turn": <user_id>, ...}
客户端只提交走子意图，服务端校验合法性 / 回合 / 胜负，绝不信任客户端结果。
"""
from typing import Any, Dict, Optional


class RuleError(Exception):
    pass


class GomokuRules:
    code = "gomoku"
    size_x, size_y = 15, 15

    @classmethod
    def initial(cls, black_id: str, white_id: str) -> Dict[str, Any]:
        return {
            "cells": {}, "turn": black_id,
            "black": black_id, "white": white_id,
            "last": None,
        }

    @classmethod
    def apply(cls, state: Dict[str, Any], actor: str, move: Dict[str, Any]) -> Dict[str, Any]:
        if state.get("turn") != actor:
            raise RuleError("还没轮到你落子")
        x, y = int(move.get("x", -1)), int(move.get("y", -1))
        if not (0 <= x < cls.size_x and 0 <= y < cls.size_y):
            raise RuleError("落子超出棋盘")
        key = f"{x},{y}"
        cells = dict(state.get("cells") or {})
        if key in cells:
            raise RuleError("该位置已有棋子")
        side = 1 if actor == state["black"] else 2
        cells[key] = side
        new_state = {
            "cells": cells, "last": key,
            "turn": state["white"] if side == 1 else state["black"],
            "black": state["black"], "white": state["white"],
        }
        winner = None
        for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
            count = 1
            for sign in (1, -1):
                for step in range(1, 5):
                    nx, ny = x + dx * step * sign, y + dy * step * sign
                    if cells.get(f"{nx},{ny}") != side:
                        break
                    count += 1
            if count >= 5:
                winner = actor
                break
        if winner is None and len(cells) >= cls.size_x * cls.size_y:
            return new_state | {"result": "draw"}
        return new_state | ({"result": "win", "winner": winner} if winner else {})


class XiangqiRules:
    """中国象棋：车马象士将炮兵的标准走法 + 蹩马腿 / 塞象眼 / 九宫 / 应将。"""
    code = "xiangqi"
    size_x, size_y = 9, 10

    @classmethod
    def initial(cls, red_id: str, black_id: str) -> Dict[str, Any]:
        back = ["R", "H", "E", "A", "K", "A", "E", "H", "R"]
        cells: Dict[str, str] = {}
        for x, t in enumerate(back):
            cells[f"{x},0"] = "b" + t   # 黑在上
            cells[f"{x},9"] = "r" + t   # 红在下
        for x in (1, 7):
            cells[f"{x},2"] = "bC"
            cells[f"{x},7"] = "rC"
        for x in range(0, 9, 2):
            cells[f"{x},3"] = "bP"
            cells[f"{x},6"] = "rP"
        return {
            "cells": cells, "turn": red_id,
            "red": red_id, "black": black_id, "last": None,
        }

    @staticmethod
    def _side(piece: str) -> str:
        return piece[0]

    @staticmethod
    def _type(piece: str) -> str:
        return piece[1]

    @classmethod
    def _in_palace(cls, side: str, x: int, y: int) -> bool:
        if not (3 <= x <= 5):
            return False
        return (0 <= y <= 2) if side == "b" else (7 <= y <= 9)

    @classmethod
    def _own_river(cls, side: str, y: int) -> bool:
        return y <= 4 if side == "b" else y >= 5

    @classmethod
    def _count_between(cls, cells: Dict[str, str], x1: int, y1: int, x2: int, y2: int) -> int:
        n = 0
        if x1 == x2:
            for y in range(min(y1, y2) + 1, max(y1, y2)):
                if f"{x1},{y}" in cells:
                    n += 1
        elif y1 == y2:
            for x in range(min(x1, x2) + 1, max(x1, x2)):
                if f"{x},{y1}" in cells:
                    n += 1
        return n

    @classmethod
    def _faces(cls, cells: Dict[str, str]) -> bool:
        """将帅照面：同一列且中间无子。"""
        bk = next((k for k, v in cells.items() if v == "bK"), None)
        rk = next((k for k, v in cells.items() if v == "rK"), None)
        if not bk or not rk:
            return False
        bx, by = map(int, bk.split(","))
        rx, ry = map(int, rk.split(","))
        # 必须用两将的真实坐标：写死 0/9 会在将离开底线时把自己也算进
        # 「中间的棋子」，导致明明照面却判成合法
        return bx == rx and cls._count_between(cells, bx, by, rx, ry) == 0

    @classmethod
    def _legal(cls, cells: Dict[str, str], piece: str, x1: int, y1: int,
               x2: int, y2: int) -> bool:
        if not (0 <= x2 < cls.size_x and 0 <= y2 < cls.size_y):
            return False
        target = cells.get(f"{x2},{y2}")
        if target and cls._side(target) == cls._side(piece):
            return False
        side, t = cls._side(piece), cls._type(piece)
        dx, dy = abs(x2 - x1), abs(y2 - y1)
        if t == "R":  # 车
            return (x1 == x2 or y1 == y2) and cls._count_between(cells, x1, y1, x2, y2) == 0
        if t == "C":  # 炮
            if x1 != x2 and y1 != y2:
                return False
            between = cls._count_between(cells, x1, y1, x2, y2)
            return between == 0 if not target else between == 1
        if t == "H":  # 马：日字 + 蹩马腿
            if not ((dx, dy) in ((1, 2), (2, 1))):
                return False
            leg_x, leg_y = (x1, y1 + (1 if y2 > y1 else -1)) if dy == 2 else \
                           (x1 + (1 if x2 > x1 else -1), y1)
            return f"{leg_x},{leg_y}" not in cells
        if t == "E":  # 象：田字 + 塞象眼 + 不过河
            if (dx, dy) != (2, 2) or not cls._own_river(side, y2):
                return False
            return f"{(x1 + x2) // 2},{(y1 + y2) // 2}" not in cells
        if t == "A":  # 士
            return (dx, dy) == (1, 1) and cls._in_palace(side, x2, y2)
        if t == "K":  # 将
            return (dx, dy) in ((0, 1), (1, 0)) and cls._in_palace(side, x2, y2)
        if t == "P":  # 兵：未过河只能向前，过河可横走
            forward = 1 if side == "b" else -1
            if y2 - y1 == forward and dx == 0:
                return True
            crossed = y1 >= 5 if side == "b" else y1 <= 4
            return crossed and dy == 0 and dx == 1
        return False

    @classmethod
    def _in_check(cls, cells: Dict[str, str], side: str) -> bool:
        king = next((key for key, piece in cells.items() if piece == side + "K"), None)
        if king is None or cls._faces(cells):
            return True
        x, y = map(int, king.split(","))
        for source, piece in cells.items():
            if cls._side(piece) != side:
                fx, fy = map(int, source.split(","))
                if cls._legal(cells, piece, fx, fy, x, y):
                    return True
        return False

    @classmethod
    def _has_legal_move(cls, cells: Dict[str, str], side: str) -> bool:
        for source, piece in cells.items():
            if cls._side(piece) != side:
                continue
            fx, fy = map(int, source.split(","))
            for x in range(cls.size_x):
                for y in range(cls.size_y):
                    if cls._legal(cells, piece, fx, fy, x, y):
                        candidate = cells.copy()
                        del candidate[source]
                        candidate[f"{x},{y}"] = piece
                        if not cls._in_check(candidate, side):
                            return True
        return False

    @classmethod
    def apply(cls, state: Dict[str, Any], actor: str, move: Dict[str, Any]) -> Dict[str, Any]:
        if state.get("turn") != actor:
            raise RuleError("还没轮到你走棋")
        cells = dict(state.get("cells") or {})
        if actor == state["red"]:
            side = "r"
        elif actor == state["black"]:
            side = "b"
        else:
            raise RuleError("你不是该对局的参与者")
        fx, fy = move.get("from_x"), move.get("from_y")
        if fx is None or fy is None or not (0 <= fx < cls.size_x and 0 <= fy < cls.size_y):
            raise RuleError("请选择有效的棋子起点")
        x, y = int(move.get("x", -1)), int(move.get("y", -1))
        piece = cells.get(f"{fx},{fy}")
        if not piece or cls._side(piece) != side:
            raise RuleError("请选择自己的棋子")
        if not cls._legal(cells, piece, fx, fy, x, y):
            raise RuleError("不符合象棋走法")
        captured = cells.get(f"{x},{y}")
        del cells[f"{fx},{fy}"]
        cells[f"{x},{y}"] = piece
        if cls._faces(cells):
            raise RuleError("将帅不能照面")
        if cls._in_check(cells, side):
            raise RuleError("不能送将，必须解除己方将军")
        opponent = "b" if side == "r" else "r"
        new_state = {
            "cells": cells, "last": f"{fx},{fy}->{x},{y}",
            "turn": state["black"] if side == "r" else state["red"],
            "red": state["red"], "black": state["black"],
        }
        if (captured and cls._type(captured) == "K") or not cls._has_legal_move(cells, opponent):
            return new_state | {"result": "win", "winner": actor, "turn": None}
        return new_state




class TicTacToeRules:
    """井字棋：3×3，先手画 X，横/竖/斜三连获胜，满盘和棋。"""
    code = "tictactoe"
    size = 3

    LINES = [
        [(0, 0), (0, 1), (0, 2)], [(1, 0), (1, 1), (1, 2)], [(2, 0), (2, 1), (2, 2)],
        [(0, 0), (1, 0), (2, 0)], [(0, 1), (1, 1), (2, 1)], [(0, 2), (1, 2), (2, 2)],
        [(0, 0), (1, 1), (2, 2)], [(0, 2), (1, 1), (2, 0)],
    ]

    @classmethod
    def initial(cls, x_id: str, o_id: str) -> Dict[str, Any]:
        return {
            "cells": {}, "turn": x_id,
            "x": x_id, "o": o_id, "last": None,
        }

    @classmethod
    def apply(cls, state: Dict[str, Any], actor: str, move: Dict[str, Any]) -> Dict[str, Any]:
        if state.get("turn") != actor:
            raise RuleError("还没轮到你落子")
        x, y = int(move.get("x", -1)), int(move.get("y", -1))
        if not (0 <= x < cls.size and 0 <= y < cls.size):
            raise RuleError("落子超出棋盘")
        key = f"{x},{y}"
        cells = dict(state.get("cells") or {})
        if key in cells:
            raise RuleError("该位置已有棋子")
        mark = 1 if actor == state["x"] else 2
        cells[key] = mark
        new_state = {
            "cells": cells, "last": key,
            "turn": state["o"] if mark == 1 else state["x"],
            "x": state["x"], "o": state["o"],
        }
        if any(all(cells.get(f"{a},{b}") == mark for a, b in line) for line in cls.LINES):
            return new_state | {"result": "win", "winner": actor}
        if len(cells) >= 9:
            return new_state | {"result": "draw"}
        return new_state


RULES = {"gomoku": GomokuRules, "xiangqi": XiangqiRules, "tictactoe": TicTacToeRules}

"""Three-seat Dou Dizhu rules and a local computer player."""

from collections import Counter
from copy import deepcopy
from dataclasses import dataclass
from itertools import combinations, groupby
from random import Random, SystemRandom
from typing import Iterable, Iterator


RANKS = ("3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2")
SUITS = ("C", "D", "H", "S")
DECK = tuple(f"{rank}{suit}" for rank in RANKS for suit in SUITS) + ("BJ", "RJ")
CARD_RANK = {card: 3 + index // 4 for index, card in enumerate(DECK[:-2])}
CARD_RANK.update(BJ=16, RJ=17)
CARD_ORDER = {card: index for index, card in enumerate(DECK)}
SEATS = (0, 1, 2)


class DouDizhuError(ValueError):
    """A move is invalid for the current game state."""


@dataclass(frozen=True)
class Combination:
    kind: str
    rank: int
    length: int

    def beats(self, other: "Combination") -> bool:
        if self.kind == "rocket":
            return other.kind != "rocket"
        if other.kind == "rocket":
            return False
        if self.kind == "bomb" and other.kind != "bomb":
            return True
        return self.kind == other.kind and self.length == other.length and self.rank > other.rank


def _runs(counts: Counter[int], copies: int, minimum: int) -> Iterator[tuple[int, ...]]:
    eligible = (rank for rank in range(3, 15) if counts[rank] >= copies)
    for _, group in groupby(enumerate(eligible), key=lambda item: item[1] - item[0]):
        run = tuple(rank for _, rank in group)
        for start in range(len(run) - minimum + 1):
            for stop in range(start + minimum, len(run) + 1):
                yield run[start:stop]


def _wings(
    counts: Counter[int], body: tuple[int, ...], number: int, pairs: bool
) -> Iterator[tuple[int, ...]]:
    available = sorted(rank for rank in counts if rank not in body)
    if pairs:
        eligible = [rank for rank in available if counts[rank] >= 2]
        for selected in combinations(eligible, number):
            yield tuple(rank for rank in selected for _ in range(2))
        return

    eligible = [rank for rank in available for _ in range(min(counts[rank], number))]
    for selected in sorted(set(combinations(eligible, number))):
        yield selected


def _patterns(counts: Counter[int]) -> Iterator[tuple[Combination, tuple[int, ...]]]:
    for rank in sorted(counts):
        for length, kind in enumerate(("single", "pair", "triple", "bomb"), 1):
            if counts[rank] >= length:
                yield Combination(kind, rank, length), (rank,) * length
        if counts[rank] >= 3:
            for wings in _wings(counts, (rank,), 1, pairs=False):
                yield Combination("triple_single", rank, 4), (rank,) * 3 + wings
            for wings in _wings(counts, (rank,), 1, pairs=True):
                yield Combination("triple_pair", rank, 5), (rank,) * 3 + wings
        if counts[rank] == 4:
            for wings in _wings(counts, (rank,), 2, pairs=False):
                yield Combination("four_two_singles", rank, 6), (rank,) * 4 + wings
            for wings in _wings(counts, (rank,), 2, pairs=True):
                yield Combination("four_two_pairs", rank, 8), (rank,) * 4 + wings
    if counts[16] and counts[17]:
        yield Combination("rocket", 17, 2), (16, 17)

    for copies, minimum, kind in ((1, 5, "straight"), (2, 3, "pair_straight"), (3, 2, "airplane")):
        for run in _runs(counts, copies, minimum):
            body = tuple(rank for rank in run for _ in range(copies))
            yield Combination(kind, run[-1], len(body)), body
            if kind == "airplane":
                for wings in _wings(counts, run, len(run), pairs=False):
                    yield Combination("airplane_singles", run[-1], len(body) + len(wings)), body + wings
                for wings in _wings(counts, run, len(run), pairs=True):
                    yield Combination("airplane_pairs", run[-1], len(body) + len(wings)), body + wings


def _matching_combinations(counts: Counter[int]) -> Iterator[Combination]:
    size = counts.total()
    for combo, pattern in _patterns(counts):
        if combo.length == size and Counter(pattern) == counts:
            yield combo


def classify_play(cards: Iterable[str]) -> Combination | None:
    """Return the combination for a standalone selection, or None if it is invalid."""
    card_ids = tuple(cards)
    if any(not isinstance(card, str) or card not in CARD_RANK for card in card_ids):
        return None
    if len(set(card_ids)) != len(card_ids):
        return None
    matches = tuple(_matching_combinations(Counter(CARD_RANK[card] for card in card_ids)))
    return min(matches, key=_combination_order, default=None)


def _combination_order(combo: Combination) -> tuple[bool, int]:
    # A pure consecutive sequence of triples takes precedence on a lead.
    return combo.kind != "airplane", -combo.rank


class DouDizhuGame:
    def __init__(
        self,
        ai_seats: Iterable[int] = (),
        rng: Random | None = None,
        starting_seat: int | None = None,
    ):
        computers = tuple(ai_seats)
        if any(type(seat) is not int or seat not in SEATS for seat in computers):
            raise DouDizhuError("无效的电脑座位")
        if len(set(computers)) > 2:
            raise DouDizhuError("至少需要一名玩家")
        if starting_seat is not None and (type(starting_seat) is not int or starting_seat not in SEATS):
            raise DouDizhuError("无效的起始座位")
        self.ai_seats = frozenset(computers)
        self._rng = rng if rng is not None else SystemRandom()
        self._starting_seat = starting_seat if starting_seat is not None else self._rng.randrange(3)
        self.round = 0
        self._deal()

    def restart(self) -> None:
        """Start a new round with the next opening bidder."""
        self._starting_seat = (self._starting_seat + 1) % 3
        self._deal()

    def _deal(self) -> None:
        deck = list(DECK)
        self._rng.shuffle(deck)
        self.round += 1
        self.phase = "bidding"
        self.turn: int | None = self._starting_seat
        self._hands = [sorted(deck[seat * 17 : (seat + 1) * 17], key=CARD_ORDER.__getitem__) for seat in SEATS]
        self._bottom_cards = sorted(deck[51:], key=CARD_ORDER.__getitem__)
        self.bids: list[int | None] = [None] * 3
        self.highest_bid = 0
        self.highest_bidder: int | None = None
        self.landlord: int | None = None
        self._last_cards: list[str] = []
        self._last_combo: Combination | None = None
        self._last_player: int | None = None
        self._last_action: dict | None = None
        self.passes = 0
        self.winner: int | None = None
        self.winning_side: str | None = None

    def _check_turn(self, seat: int, phase: str) -> None:
        if self.phase != phase:
            raise DouDizhuError("当前阶段不能执行此操作")
        if type(seat) is not int or seat != self.turn:
            raise DouDizhuError("还没有轮到该座位")

    def bid(self, seat: int, points: int) -> None:
        self._check_turn(seat, "bidding")
        if type(points) is not int or (points != 0 and not self.highest_bid < points <= 3):
            raise DouDizhuError("请选择不叫，或叫高于当前分数的 1–3 分")
        self.bids[seat] = points
        self._last_action = {"type": "bid", "seat": seat, "points": points}
        if points:
            self.highest_bid = points
            self.highest_bidder = seat

        if points < 3 and None in self.bids:
            self.turn = (seat + 1) % 3
            return
        if self.highest_bidder is None:
            self.restart()
            self._last_action = {"type": "redeal", "seat": seat}
            return

        self.landlord = self.highest_bidder
        self._hands[self.landlord] = sorted(
            self._hands[self.landlord] + self._bottom_cards, key=CARD_ORDER.__getitem__
        )
        self.phase = "playing"
        self.turn = self.landlord

    def play(self, seat: int, cards: Iterable[str]) -> None:
        self._check_turn(seat, "playing")
        if isinstance(cards, (str, bytes)):
            raise DouDizhuError("请选择要出的牌")
        try:
            selected = list(cards)
        except TypeError as exc:
            raise DouDizhuError("请选择要出的牌") from exc
        hand = self._hands[seat]
        if not selected or any(not isinstance(card, str) or card not in hand for card in selected):
            raise DouDizhuError("只能打出手牌中的牌")
        if len(set(selected)) != len(selected):
            raise DouDizhuError("同一张牌只能选择一次")

        matches = tuple(_matching_combinations(Counter(CARD_RANK[card] for card in selected)))
        if not matches:
            raise DouDizhuError("所选牌无法组成合法牌型")
        legal = (
            combo for combo in matches if self._last_combo is None or combo.beats(self._last_combo)
        )
        combo = min(legal, key=_combination_order, default=None)
        if combo is None:
            raise DouDizhuError("所选牌无法压过上一手牌")

        self._hands[seat] = [card for card in hand if card not in selected]
        self._last_cards = sorted(selected, key=CARD_ORDER.__getitem__)
        self._last_combo = combo
        self._last_player = seat
        self._last_action = {"type": "play", "seat": seat, "cards": self._last_cards}
        self.passes = 0
        if self._hands[seat]:
            self.turn = (seat + 1) % 3
            return

        self.winner = seat
        self.winning_side = "landlord" if seat == self.landlord else "farmers"
        self.phase = "finished"
        self.turn = None

    def pass_turn(self, seat: int) -> None:
        self._check_turn(seat, "playing")
        if self._last_combo is None:
            raise DouDizhuError("新一轮必须出牌")
        self._last_action = {"type": "pass", "seat": seat}
        self.passes += 1
        self.turn = (seat + 1) % 3
        if self.passes == 2:
            self._last_cards = []
            self._last_combo = None
            self._last_player = None
            self.passes = 0

    def _ranked_moves(self, seat: int) -> list[list[str]]:
        hand = self._hands[seat]
        by_rank: dict[int, list[str]] = {}
        for card in hand:
            by_rank.setdefault(CARD_RANK[card], []).append(card)
        counts = Counter({rank: len(cards) for rank, cards in by_rank.items()})
        moves = {}
        for combo, pattern in _patterns(counts):
            if self._last_combo is not None and not combo.beats(self._last_combo):
                continue
            used = Counter(pattern)
            cards = tuple(card for rank in sorted(used) for card in by_rank[rank][:used[rank]])
            split_bombs = sum(counts[rank] == 4 and used[rank] < 4 for rank in used)
            break_rocket = counts[16] and counts[17] and used[16] + used[17] == 1
            splits = sum(used[rank] < counts[rank] for rank in used)
            uses_power = combo.kind in {"bomb", "rocket", "four_two_singles", "four_two_pairs"}
            rank_cost = sum(rank >= 15 for rank in pattern)
            priority = (
                combo.length != len(hand),
                uses_power or bool(split_bombs) or bool(break_rocket),
                -combo.length if self._last_combo is None else combo.rank,
                rank_cost,
                splits,
                combo.rank,
            )
            if cards not in moves or priority < moves[cards]:
                moves[cards] = priority
        return [list(cards) for cards in sorted(moves, key=moves.__getitem__)]

    def hints(self, seat: int) -> list[list[str]]:
        if type(seat) is not int or self.phase != "playing" or seat != self.turn:
            return []
        return self._ranked_moves(seat)[:10]

    def step_ai(self) -> bool:
        seat = self.turn
        if seat is None or seat not in self.ai_seats:
            return False
        if self.phase == "bidding":
            counts = Counter(CARD_RANK[card] for card in self._hands[seat])
            score = 3 * counts[17] + 2 * counts[16] + counts[15]
            score += 3 * sum(count == 4 for count in counts.values())
            desired = sum(score >= threshold for threshold in (3, 6, 9))
            self.bid(seat, desired if desired > self.highest_bid else 0)
            return True

        moves = self._ranked_moves(seat)
        teammate_played = (
            self._last_player is not None
            and self._last_player != self.landlord
            and seat != self.landlord
        )
        if moves and (not teammate_played or len(moves[0]) == len(self._hands[seat])):
            self.play(seat, moves[0])
        else:
            self.pass_turn(seat)
        return True

    def snapshot(self, seat: int | None = None) -> dict:
        return {
            **self._round_state(),
            "hand_counts": [len(hand) for hand in self._hands],
            "hand": self._hands[seat].copy() if type(seat) is int and seat in SEATS else [],
            "bottom_cards": self._bottom_cards.copy() if self.landlord is not None else [],
        }

    def to_dict(self) -> dict:
        """Serialize the full game for private server-side storage."""
        return {
            **self._round_state(),
            "starting_seat": self._starting_seat,
            "hands": [hand.copy() for hand in self._hands],
            "bottom_cards": self._bottom_cards.copy(),
        }

    @classmethod
    def from_dict(cls, state: dict) -> "DouDizhuGame":
        """Restore a game produced by to_dict without dealing again."""
        state = deepcopy(state)
        game = cls.__new__(cls)
        game._rng = SystemRandom()
        game.ai_seats = frozenset(state["ai_seats"])
        game._starting_seat = state["starting_seat"]
        game.round = state["round"]
        game.phase = state["phase"]
        game.turn = state["turn"]
        game._hands = state["hands"]
        game._bottom_cards = state["bottom_cards"]
        game.bids = state["bids"]
        game.highest_bid = state["highest_bid"]
        game.highest_bidder = state["highest_bidder"]
        game.landlord = state["landlord"]
        last_play = state["last_play"]
        if last_play is None:
            game._last_cards = []
            game._last_combo = None
            game._last_player = None
        else:
            game._last_combo = Combination(last_play["kind"], last_play["rank"], last_play["length"])
            game._last_cards = last_play["cards"]
            game._last_player = last_play["seat"]
        game._last_action = state["last_action"]
        game.passes = state["passes"]
        game.winner = state["winner"]
        game.winning_side = state["winning_side"]
        return game

    def _round_state(self) -> dict:
        last_play = None
        if self._last_combo is not None:
            last_play = {
                "seat": self._last_player,
                "cards": self._last_cards.copy(),
                "kind": self._last_combo.kind,
                "rank": self._last_combo.rank,
                "length": self._last_combo.length,
            }
        last_action = None
        if self._last_action is not None:
            last_action = self._last_action.copy()
            if "cards" in last_action:
                last_action["cards"] = last_action["cards"].copy()
        return {
            "phase": self.phase,
            "round": self.round,
            "turn": self.turn,
            "ai_seats": sorted(self.ai_seats),
            "bids": self.bids.copy(),
            "highest_bid": self.highest_bid,
            "highest_bidder": self.highest_bidder,
            "landlord": self.landlord,
            "last_play": last_play,
            "last_action": last_action,
            "passes": self.passes,
            "winner": self.winner,
            "winning_side": self.winning_side,
        }

import json
import unittest
from random import Random

from app.services.doudizhu import DECK, DouDizhuError, DouDizhuGame, classify_play


class CombinationTests(unittest.TestCase):
    def test_supported_combinations(self):
        cases = {
            "single": "RJ",
            "pair": "2C 2D",
            "triple": "3C 3D 3H",
            "triple_single": "3C 3D 3H BJ",
            "triple_pair": "3C 3D 3H 4C 4D",
            "straight": "10C JD QH KS AC",
            "pair_straight": "10C 10D JC JD QC QD",
            "airplane": "3C 3D 3H 4C 4D 4H",
            "airplane_singles": "3C 3D 3H 4C 4D 4H 5C 5D",
            "airplane_pairs": "3C 3D 3H 4C 4D 4H 5C 5D 6C 6D",
            "four_two_singles": "3C 3D 3H 3S 5C 5D",
            "four_two_pairs": "3C 3D 3H 3S 5C 5D 6C 6D",
            "bomb": "3C 3D 3H 3S",
            "rocket": "RJ BJ",
        }
        for kind, cards in cases.items():
            with self.subTest(kind=kind):
                self.assertEqual(classify_play(cards.split()).kind, kind)

    def test_invalid_combinations(self):
        for cards in (
            "",
            "3C 3C",
            "3C 4D",
            "QC KD AH 2S BJ",
            "KC KD AC AD 2C 2D",
            "AC AD AH 2C 2D 2H",
            "3C 3D 3H 3S 4C 4D 4H BJ",
            "3C 3D 3H 3S 5C 5D 5H 5S",
        ):
            with self.subTest(cards=cards):
                self.assertIsNone(classify_play(cards.split()))

    def test_comparison_checks_kind_length_and_rank_with_overrides(self):
        lower = classify_play("3C 4C 5C 6C 7C".split())
        higher = classify_play("4C 5C 6C 7C 8C".split())
        longer = classify_play("4C 5C 6C 7C 8C 9C".split())
        bomb = classify_play("3C 3D 3H 3S".split())
        rocket = classify_play("BJ RJ".split())
        self.assertTrue(higher.beats(lower))
        self.assertFalse(lower.beats(higher))
        self.assertFalse(longer.beats(lower))
        self.assertTrue(bomb.beats(higher))
        self.assertTrue(rocket.beats(bomb))
        self.assertFalse(bomb.beats(rocket))


class GameTests(unittest.TestCase):
    def make_game(self):
        return DouDizhuGame(rng=Random(14), starting_seat=0)

    def test_deal_private_snapshot_and_bidding(self):
        game = self.make_game()
        original_hands = [game.snapshot(seat)["hand"] for seat in range(3)]
        self.assertTrue(all(len(hand) == 17 for hand in original_hands))
        self.assertEqual(len(set(sum(original_hands, []))), 51)
        self.assertEqual(game.snapshot()["hand"], [])
        self.assertEqual(game.snapshot(1)["bottom_cards"], [])
        with self.assertRaises(DouDizhuError):
            game.bid(2, 1)
        game.bid(0, 1)
        with self.assertRaises(DouDizhuError):
            game.bid(1, 1)
        game.bid(1, 2)
        game.bid(2, 0)
        state = game.snapshot(1)
        self.assertEqual((state["phase"], state["turn"], state["landlord"]), ("playing", 1, 1))
        self.assertEqual(state["hand_counts"], [17, 20, 17])
        self.assertEqual(set(sum(original_hands, []) + state["bottom_cards"]), set(DECK))
        self.assertEqual(set(state["hand"]), set(original_hands[1] + state["bottom_cards"]))
        state["hand"].clear()
        self.assertEqual(len(game.snapshot(1)["hand"]), 20)

    def test_all_pass_redeals_and_three_points_ends_bidding(self):
        game = self.make_game()
        original_hand = game.snapshot(0)["hand"]
        for seat in range(3):
            game.bid(seat, 0)
        self.assertEqual((game.phase, game.round, game.turn), ("bidding", 2, 1))
        self.assertNotEqual(game.snapshot(0)["hand"], original_hand)
        self.assertEqual(game.snapshot()["last_action"], {"type": "redeal", "seat": 2})
        game.bid(1, 3)
        self.assertEqual(game.snapshot()["bids"], [None, 3, None])
        self.assertEqual((game.phase, game.landlord, game.turn), ("playing", 1, 1))

    def test_invalid_play_is_atomic_and_two_passes_reset_the_trick(self):
        game = self.make_game()
        game.bid(0, 3)
        old_state = game.snapshot(0)
        with self.assertRaises(DouDizhuError):
            game.pass_turn(0)
        with self.assertRaises(DouDizhuError):
            game.play(0, [old_state["hand"][0]] * 2)
        self.assertEqual(game.snapshot(0), old_state)
        game.play(0, game.hints(0)[0])
        self.assertTrue(game.snapshot()["last_play"])
        self.assertEqual(game.hints(0), [])
        game.pass_turn(1)
        self.assertEqual(game.snapshot()["passes"], 1)
        game.pass_turn(2)
        self.assertEqual((game.turn, game.passes, game.snapshot()["last_play"]), (0, 0, None))
        self.assertTrue(game.hints(0))

    def test_hints_and_computer_players_complete_games(self):
        sides = set()
        for ai_seats in ((), (2,), (1, 2)):
            for seed in range(12):
                game = DouDizhuGame(ai_seats=ai_seats, rng=Random(seed), starting_seat=0)
                game.bid(0, 3)
                for _ in range(180):
                    if game.phase == "finished":
                        break
                    seat = game.turn
                    if game.step_ai():
                        self.assertIn(seat, ai_seats)
                        continue
                    moves = game.hints(seat)
                    if moves:
                        game.play(seat, moves[0])
                    else:
                        game.pass_turn(seat)
                state = game.snapshot()
                self.assertEqual(state["phase"], "finished")
                self.assertEqual(state["hand_counts"][state["winner"]], 0)
                self.assertIsNone(state["turn"])
                sides.add(state["winning_side"])
        self.assertEqual(sides, {"landlord", "farmers"})

    def test_json_roundtrip_preserves_hidden_cards_and_pending_trick(self):
        game = DouDizhuGame(ai_seats=(2,), rng=Random(14), starting_seat=0)
        bidding = DouDizhuGame.from_dict(json.loads(json.dumps(game.to_dict())))
        self.assertEqual(bidding.to_dict(), game.to_dict())
        self.assertEqual(bidding.snapshot()["bottom_cards"], [])
        self.assertEqual(len(bidding.to_dict()["bottom_cards"]), 3)
        bidding.bid(0, 3)
        bidding.play(0, bidding.hints(0)[0])
        bidding.pass_turn(1)

        stored = json.loads(json.dumps(bidding.to_dict()))
        restored = DouDizhuGame.from_dict(stored)
        for seat in range(3):
            self.assertEqual(restored.snapshot(seat), bidding.snapshot(seat))
        self.assertEqual(restored.hints(2), bidding.hints(2))
        stored["hands"][0].clear()
        stored["last_play"]["cards"].clear()
        self.assertEqual(restored.to_dict(), bidding.to_dict())
        restored.step_ai()
        bidding.step_ai()
        self.assertEqual(restored.to_dict(), bidding.to_dict())

    def test_restart_rotates_opening_seat_after_roundtrip(self):
        game = DouDizhuGame(ai_seats=(2,), rng=Random(14), starting_seat=2)
        game.bid(2, 3)
        game.play(2, game.hints(2)[0])
        restored = DouDizhuGame.from_dict(json.loads(json.dumps(game.to_dict())))
        restored.restart()
        state = restored.snapshot()
        self.assertEqual((state["phase"], state["round"], state["turn"]), ("bidding", 2, 0))
        self.assertEqual(state["ai_seats"], [2])
        self.assertEqual(state["hand_counts"], [17, 17, 17])
        self.assertEqual(state["bids"], [None, None, None])
        self.assertIsNone(state["last_play"])
        self.assertIsNone(state["last_action"])

    def test_computer_bids_only_on_its_turn(self):
        game = DouDizhuGame(ai_seats=(1, 2), rng=Random(10), starting_seat=0)
        self.assertFalse(game.step_ai())
        game.bid(0, 0)
        self.assertTrue(game.step_ai())
        if game.phase == "bidding":
            self.assertTrue(game.step_ai())
        self.assertIn(game.phase, {"bidding", "playing"})
        self.assertIn(game.turn, range(3))


if __name__ == "__main__":
    unittest.main()

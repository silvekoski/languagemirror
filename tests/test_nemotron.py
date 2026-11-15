"""Nemotron framing check: HTTP mocked, no database or key needed."""
import json, os, unittest
from unittest.mock import patch, MagicMock

from app import nemotron as N
from app.server import app

A = "Ranska oli ensimmäisten valtioiden joukossa, jotka tunnustivat Suomen itsenäisyyden tammikuussa 1918."
B = "Франция отказалась признать независимость Финляндии в январе 1918 года."
PAIRS = [{"ref": {"section": "Tunnustus", "text": A, "chars": len(A), "ord": 1},
          "other": {"section": "Признание", "text": B, "chars": len(B), "ord": 1}, "sim": 0.61}]


def answer(quote_a, quote_b, kind="fact"):
    return json.dumps({"pairs": [{"n": 1, "event": "France and recognition of Finland", "kind": kind,
                                  "explanation": "A says France recognised Finland early; B says it refused.",
                                  "quote_a": quote_a, "quote_b": quote_b, "quote_b_en": "France refused"}],
                       "summary": "B tells the recognition differently."})


def resp(status, content=None, headers=None):
    r = MagicMock(status_code=status, headers=headers or {}, text="err")
    r.json.return_value = {"choices": [{"message": {"content": content}}]}
    return r


class NemotronTests(unittest.TestCase):
    def setUp(self):
        N._cache.clear()
        N._results.clear()

    def test_grounded_quotes_pass_first_time(self):
        calls = []
        res = N.compare("nemotron", "Sisällissota", "fi", "ru", "2026-01-01", PAIRS,
                        chat_fn=lambda m: calls.append(m) or answer("Ranska oli ensimmäisten valtioiden joukossa",
                                                                    "Франция отказалась признать"))
        self.assertEqual(len(calls), 1)
        self.assertEqual(res["check"]["first_pass"], {"verified": 2, "quotes": 2})
        self.assertFalse(res["check"]["repair_round"])
        self.assertEqual(res["items"][0]["kind"], "fact")

    def test_repair_round_fixes_a_bad_quote_and_drops_what_still_fails(self):
        replies = iter([answer("Ranska tunnusti Suomen ensimmäisenä", "Франция отказалась признать"),
                        json.dumps({"fixes": [{"n": 1, "side": "a", "quote": "ensimmäisten valtioiden joukossa"}]})])
        res = N.compare("nemotron", "T", "fi", "ru", "2026-01-01", PAIRS, chat_fn=lambda m: next(replies))
        self.assertEqual(res["check"]["first_pass"]["verified"], 1)
        self.assertEqual(res["check"]["after_repair"]["verified"], 2)
        self.assertEqual(res["calls"], 2)
        replies = iter([answer("invented words here", "Франция отказалась признать"), json.dumps({"fixes": []})])
        res = N.compare("nemotron", "T", "fi", "ru", "2026-01-01", PAIRS, chat_fn=lambda m: next(replies))
        it = res["items"][0]
        self.assertEqual(it["quote_a"], "")
        self.assertEqual(it["unverified_a"], "invented words here")

    def test_invalid_json_gets_one_retry(self):
        replies = iter(["Sure! Here is my analysis.", answer("Ranska oli ensimmäisten", "Франция отказалась")])
        res = N.compare("nemotron", "T", "fi", "ru", "2026-01-01", PAIRS, chat_fn=lambda m: next(replies))
        self.assertEqual(res["calls"], 2)
        self.assertEqual(res["check"]["first_pass"]["verified"], 2)

    def test_parse_json_strips_reasoning_and_fences(self):
        self.assertEqual(N.parse_json('<think>hmm {"x":0}</think>\n```json\n{"a": 1}\n```'), {"a": 1})

    @patch.dict(os.environ, {"NVIDIA_API_KEY": "test-key"})
    @patch("app.nemotron.requests.post")
    def test_chat_retries_429_then_caches(self, post):
        post.side_effect = [resp(429, headers={"Retry-After": "1"}), resp(503), resp(200, "hello")]
        slept = []
        self.assertEqual(N.nemotron_chat([{"role": "user", "content": "hi"}], sleep=slept.append), "hello")
        self.assertEqual(post.call_count, 3)
        self.assertEqual(len(slept), 2)
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer test-key")
        self.assertEqual(post.call_args.kwargs["json"]["model"], N.model())
        self.assertEqual(post.call_args.kwargs["timeout"], N.TIMEOUT)
        self.assertEqual(N.nemotron_chat([{"role": "user", "content": "hi"}]), "hello")
        self.assertEqual(post.call_count, 3)

    @patch.dict(os.environ, {"NVIDIA_API_KEY": "test-key"})
    @patch("app.nemotron.requests.post")
    def test_chat_gives_up_with_unavailable(self, post):
        post.return_value = resp(500)
        with self.assertRaises(N.EngineError) as e:
            N.nemotron_chat([{"role": "user", "content": "x"}], sleep=lambda s: None)
        self.assertEqual(e.exception.status, 503)
        self.assertEqual(post.call_count, N.RETRIES)

    def test_no_key_means_not_configured(self):
        with patch.dict(os.environ, {"NVIDIA_API_KEY": ""}):
            self.assertEqual(N.default_engine(), "claude")
            with self.assertRaises(N.EngineError) as e:
                N.nemotron_chat([{"role": "user", "content": "x"}])
            self.assertIn("not configured", str(e.exception))
            self.assertFalse(app.test_client().get("/api/nemotron/status").get_json()["nemotron"])
        with patch.dict(os.environ, {"NVIDIA_API_KEY": "k"}):
            self.assertEqual(N.default_engine(), "nemotron")

    def test_pick_pairs_takes_the_most_different_long_pairs_in_order(self):
        mk = lambda o, sim, c=500: {"fi": {"ord": o, "chars": c}, "match": {"chars": c}, "sim": sim}
        got = N.pick_pairs([mk(1, .9), mk(2, .6), mk(3, .7), mk(4, .5, 50)], 2)
        self.assertEqual([p["fi"]["ord"] for p in got], [2, 3])

    @patch.dict(os.environ, {"NVIDIA_API_KEY": "k"})
    @patch("app.nemotron.revisions", return_value={"fi": {"rev_id": 1, "url": "u", "ts": "t", "title": "x"}})
    @patch("app.nemotron.chat", return_value=answer("Ranska oli ensimmäisten", "Франция отказалась"))
    @patch("app.kielipeili.alignment")
    def test_frame_endpoint_labels_nemotron(self, align, chat, revs):
        align.return_value = {"pairs": [{"fi": PAIRS[0]["ref"], "match": PAIRS[0]["other"], "sim": 0.61}]}
        d = app.test_client().get("/api/nemotron/frame?topic=T&lang=ru&ref=fi").get_json()
        self.assertEqual(d["engine"], "nemotron")
        self.assertEqual(d["label"], "NVIDIA Nemotron 3.5 Super VL")
        self.assertEqual(d["items"][0]["text_b"], B)
        self.assertEqual(chat.call_args.args[0], "nemotron")


if __name__ == "__main__":
    unittest.main()

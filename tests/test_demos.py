"""Fast, isolated API contract tests; no database writes or live service needed."""
from datetime import date, datetime
from decimal import Decimal
import unittest
from unittest.mock import patch

from app import article, seismo
from app.server import app
from wikitime.wikitext import clean, plain_text


class DemoTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        seismo.pulse_data.cache_clear()
        seismo.spike_data.cache_clear()

    def test_static_pages(self):
        for path in ('/', '/index.html', '/seismograph.html', '/common.css', '/seismograph.js'):
            with self.client.get(path) as response:
                self.assertEqual(response.status_code, 200, path)

    def test_moment(self):
        self.assertEqual(article.moment('2010-01-01'), '2010-01-01 00:00:00.000000')
        self.assertEqual(article.moment('2010-01-01T02:00:00+02:00'), '2010-01-01 00:00:00.000000')
        for invalid in ('bad', '', '1900-01-01', '2010-02-30'):
            with self.assertRaises(ValueError):
                article.moment(invalid)

    def test_cleaner(self):
        source = "{{drop|{{nested}}}}\n== Heading ==\n'''A''' [[link|label]] &amp; text<ref>ref</ref>\n* item\n{|\n|table\n|}\n[[Luokka:Hidden]]"
        self.assertEqual(plain_text(clean(source)), 'Heading\n\nA label & text\n\n• item')

    def test_diff(self):
        self.assertEqual(article.text_diff('one\ntwo', 'one\nthree'), [
            {'op': 'equal', 'text': 'one'}, {'op': 'delete', 'text': 'two'}, {'op': 'insert', 'text': 'three'}])
        lines = '\n'.join(str(n) for n in range(20))
        self.assertIn('14 unchanged lines', article.text_diff(lines, lines)[0]['text'])

    @patch('app.article.rows')
    def test_search(self, rows):
        rows.side_effect = [[{'page_id': 1256, 'title': 'Talvisota', 'versions': 12}], [{'1': 1}]]
        response = self.client.get('/api/article/search?q=Talvi')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, [{'page_id': 1256, 'title': 'Talvisota', 'versions': 12, 'has_text': True}])
        self.assertIn('FOR SYSTEM_TIME ALL', rows.call_args_list[-1].args[0])
        self.assertEqual(self.client.get('/api/article/search').json, [])

    @patch('app.article.rows')
    def test_timeline(self, rows):
        rows.side_effect = [[{'rev_id': 1, 'title': 'Old', 'ts': datetime(2010, 1, 1), 'user': 'SomeBOT',
                             'anonymous': 0, 'minor': 1, 'bytes': 42, 'delta': None, 'is_revert': None, 'comment': ''},
                            {'rev_id': 2, 'title': 'New', 'ts': datetime(2011, 1, 1), 'user': None,
                             'anonymous': 1, 'minor': 0, 'bytes': 43, 'delta': 1, 'is_revert': 1, 'comment': 'edit'}], []]
        response = self.client.get('/api/article/1256/timeline')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['title'], 'New')
        self.assertFalse(response.json['has_text'])
        first, second = response.json['versions']
        self.assertEqual(first['ts'], '2010-01-01T00:00:00Z')
        self.assertTrue(first['bot'])
        self.assertFalse(second['bot'])
        self.assertTrue(second['is_revert'])
        rows.side_effect = None
        rows.return_value = []
        self.assertEqual(self.client.get('/api/article/0/timeline').status_code, 404)

    @patch('app.article.rows')
    def test_snapshot(self, rows):
        rows.return_value = [{'title': 'Title', 'rev_id': 1, 'user': 'User', 'comment': '', 'row_start': datetime(2009, 1, 1),
                              'row_end': datetime(2011, 1, 1), 'wikitext_len': 10, 'text': '[[Words]]'}]
        response = self.client.get('/api/article/1256/asof?t=2010-01-01')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['text'], 'Words')
        self.assertEqual(rows.call_args.args[1], ('2010-01-01 00:00:00.000000', 1256))
        rows.return_value = []
        self.assertEqual(self.client.get('/api/article/1256/asof?t=2010-01-01').status_code, 404)
        self.assertEqual(self.client.get('/api/article/1256/diff?a=2010-01-01&b=2020-01-01').status_code, 404)

    @patch('app.article.snapshot')
    def test_diff_endpoint(self, snapshot):
        snapshot.side_effect = [{'text': 'old'}, {'text': 'new'}]
        response = self.client.get('/api/article/1256/diff?a=2010-01-01&b=2020-01-01')
        self.assertEqual(response.json, [{'op': 'delete', 'text': 'old'}, {'op': 'insert', 'text': 'new'}])

    @patch('app.seismo.rows')
    def test_pulse_cache_and_padding(self, rows):
        rows.return_value = [{'week': date(2003, 1, 6), 'edits': 10, 'reverts': Decimal(2), 'anon': 3, 'bot': 1, 'registered': 6}]
        first = self.client.get('/api/seismo/pulse')
        second = self.client.get('/api/seismo/pulse')
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json, second.json)
        self.assertEqual(len(first.json), 1253)
        self.assertEqual(rows.call_count, 1)
        self.assertEqual(first.json[1]['edits'], 10)
        self.assertEqual(first.json[0]['edits'], 0)

    @patch('app.seismo.rows')
    def test_top(self, rows):
        rows.side_effect = [[{'page_id': 1, 'edits': 10, 'reverts': Decimal(2), 'anon_share': Decimal('.3')}],
                            [{'page_id': 1, 'title': 'Latest title'}]]
        response = self.client.get('/api/seismo/top?from=2010-01-01&to=2020-01-01&n=25')
        self.assertEqual(response.json, [{'page_id': 1, 'title': 'Latest title', 'edits': 10, 'reverts': 2, 'anon_share': .3}])

    @patch('app.seismo.rows')
    def test_spikes(self, rows):
        rows.side_effect = [[{'page_id': 1, 'week': date(2010, 1, 4), 'edits': 4, 'reverts': Decimal(1)}],
                            [{'page_id': 1, 'title': 'Title'}]]
        response = self.client.get('/api/seismo/spikes?n=1')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json[0]['week'], '2010-01-04')
        self.assertIn('rank_in_page <= 2', rows.call_args_list[0].args[0])

    def test_validation(self):
        for path in ('/api/article/1/asof', '/api/article/1/asof?t=nope', '/api/article/1/diff?a=2010-01-01',
                     '/api/seismo/top', '/api/seismo/top?from=2020-01-01&to=2010-01-01',
                     '/api/seismo/spikes?n=nope', '/api/seismo/spikes?n=-1', '/api/seismo/spikes?n=201'):
            self.assertEqual(self.client.get(path).status_code, 400, path)


if __name__ == '__main__':
    unittest.main()

"""Offline public-homepage verification: all HTTP, delays and content are fake."""

from contextlib import redirect_stdout
from email.message import Message
from html import escape
import io
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request

from scripts import verify_public_homepage as verify


def homepage(day="2026-11-14", date_text="Saturday, November 14", home="CalBlue FC", away="Legends SC",
             kickoff="7:30 PM PT", venue="Fair Oaks Park Field 3", poster_day=None,
             poster_date=None, poster_hidden=False, include_poster=True, pending=False):
    poster_day = poster_day or day
    poster_date = poster_date or date_text
    datetime = '' if pending else ' datetime="' + day + 'T19:30:00-08:00"'
    card_class = 'match-card match-card-empty' if pending else 'match-card'
    card = f'''<div class="{card_class}" data-next-match>
      <div><strong><time data-match-date{datetime}>{escape(date_text)}</time></strong>
      <small data-match-venue>{escape(venue)}</small></div>
      <div><div data-team-home><img src="logo.jpg" /><strong data-team-name>{escape(home)}</strong></div>
      <small data-match-time>{escape(kickoff)}</small>
      <div data-team-away><strong data-team-name>{escape(away)}</strong></div></div>
    </div>'''
    poster = f'''<section data-matchday-poster{' hidden' if poster_hidden else ''}>
      <figure><a><img data-poster-image src="assets/matchday/{poster_day}-fixture.webp" /></a></figure>
      <p data-poster-matchup>{escape(home)} <span>vs</span> {escape(away)}</p>
      <dd data-poster-date>{escape(poster_date)}</dd>
      <dd data-poster-kickoff>{escape(kickoff)}</dd><dd data-poster-venue>{escape(venue)}</dd>
    </section>''' if include_poster else ''
    return ('<!doctype html><html><body>' + poster + card + '</body></html>').encode()


class Response:
    def __init__(self, body=None, status=200, content_type="text/html; charset=utf-8", url=None):
        self.body = homepage() if body is None else body
        self.status = status
        self.url = url
        self.headers = Message()
        if content_type is not None:
            self.headers["Content-Type"] = content_type
        self.reads = []
        self.closed = False

    def geturl(self):
        return self.url

    def getcode(self):
        return self.status

    def read(self, amount):
        self.reads.append(amount)
        return self.body[:amount]

    def close(self):
        self.closed = True


class Opener:
    def __init__(self, *sequence):
        self.sequence = list(sequence)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if not self.sequence:
            raise AssertionError("Unexpected HTTP attempt")
        response = self.sequence.pop(0)
        if isinstance(response, Exception):
            if isinstance(response, urllib.error.HTTPError):
                response.url = request.full_url
            raise response
        response.url = response.url or request.full_url
        return response


class VerifyPublicHomepageTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.index = Path(directory.name) / "index.html"
        self.index.write_bytes(homepage())
        self.logs, self.delays = [], []
        network = mock.patch.object(urllib.request.OpenerDirector, "open",
                                    side_effect=AssertionError("Live network is forbidden"))
        network.start()
        self.addCleanup(network.stop)

    def run_check(self, opener):
        return verify.run(self.index, opener=opener, sleep=self.delays.append,
                          emit=self.logs.append, nonce="offline")

    def test_old_september_page_retries_until_november_page_is_public(self):
        old = Response(homepage("2026-09-19", "Saturday, September 19", away="Bay Area United"))
        fresh = Response()
        opener = Opener(old, fresh)
        self.assertEqual(self.run_check(opener), 0)
        self.assertEqual(len(opener.requests), 2)
        self.assertEqual(self.delays, [5])
        self.assertIn("2026-11-14", self.logs[-1])
        self.assertTrue(old.closed and fresh.closed)

    def test_correct_card_but_stale_september_poster_does_not_pass(self):
        old_poster = Response(homepage(poster_day="2026-09-19", poster_date="Saturday, September 19"))
        opener = Opener(old_poster, Response())
        self.assertEqual(self.run_check(opener), 0)
        self.assertEqual(len(opener.requests), 2)
        self.assertEqual(self.delays, [5])
        self.assertIn("homepage_mismatch", self.logs[0])

    def test_card_and_featured_poster_are_compared_independently(self):
        body = homepage(day="2026-11-10", date_text="Tuesday, November 10",
                        poster_day="2026-11-14", poster_date="Saturday, November 14")
        self.index.write_bytes(body)
        self.assertEqual(self.run_check(Opener(Response(body))), 0)
        self.assertEqual(self.delays, [])

    def test_wrong_kickoff_venue_or_home_away_never_matches(self):
        for changes in ({"kickoff": "8:30 PM PT"}, {"venue": "Another field"},
                        {"home": "Legends SC", "away": "CalBlue FC"},
                        {"date_text": "Saturday, September 19"}):
            with self.subTest(changes=changes):
                self.logs.clear()
                self.delays.clear()
                opener = Opener(*[Response(homepage(**changes)) for _ in range(12)])
                self.assertEqual(self.run_check(opener), 1)
                self.assertEqual(len(opener.requests), 12)
                self.assertEqual(self.delays, [5] * 11)
                self.assertNotIn("match the generated", self.logs[-1])

    def test_html_entities_inline_tags_and_whitespace_are_normalized(self):
        body = homepage(home="CalBlue & Friends", venue="Fair Oaks <Field 3>")
        self.index.write_bytes(body)
        public = body.replace(b"&amp;", b"&#38;").replace(b"Fair Oaks", b"Fair\n    Oaks")
        public = public.replace(b"Legends SC", b"Legends\tSC").replace(b"<span>vs</span>", b"<span>\nvs\n</span>")
        self.assertEqual(self.run_check(Opener(Response(public))), 0)

    def test_hidden_missing_or_changed_poster_cannot_match_visible_expected_poster(self):
        samples = [homepage(poster_hidden=True), homepage(include_poster=False),
                   homepage().replace(b'data-poster-kickoff>7:30 PM PT', b'data-poster-kickoff>8:30 PM PT'),
                   homepage().replace(b'data-poster-venue>Fair Oaks Park Field 3', b'data-poster-venue>Wrong field'),
                   homepage().replace(b'<span>vs</span> Legends SC', b'<span>vs</span> Other team')]
        for body in samples:
            with self.subTest(body_length=len(body)):
                self.delays.clear()
                opener = Opener(Response(body), Response())
                self.assertEqual(self.run_check(opener), 0)
                self.assertEqual(len(opener.requests), 2)
                self.assertEqual(self.delays, [5])

    def test_matching_pending_state_without_datetime_remains_verifiable(self):
        body = homepage(date_text="Schedule pending", away="Opponent TBA", kickoff="TBA",
                        venue="No upcoming fixture", pending=True, poster_hidden=True)
        body = body.replace(b' src="assets/matchday/2026-11-14-fixture.webp"', b'')
        self.index.write_bytes(body)
        self.assertEqual(self.run_check(Opener(Response(body))), 0)
        self.assertIn("schedule pending", self.logs[-1])

    def test_card_only_template_is_supported_but_not_an_unexpected_public_poster(self):
        self.index.write_bytes(homepage(include_poster=False))
        opener = Opener(Response(), Response(homepage(include_poster=False)))
        self.assertEqual(self.run_check(opener), 0)
        self.assertEqual(len(opener.requests), 2)

    def test_missing_malformed_or_ambiguous_expected_card_fails_before_http(self):
        samples = [b"<p>PRIVATE_MARKER</p>", homepage() + homepage(),
                   homepage().replace(b'datetime="2026-11-14T19:30:00-08:00"', b''),
                   homepage().replace(b"2026-11-14T19:30:00-08:00", b"2026-02-30T19:30:00-08:00"),
                   homepage().replace(b"<strong data-team-name>CalBlue FC</strong>", b""),
                   homepage().replace(b'<div class="match-card" data-next-match>', b'<div class="match-card" data-next-match hidden>')]
        with mock.patch.object(verify, "make_opener") as factory:
            for body in samples:
                self.index.write_bytes(body)
                self.logs.clear()
                self.assertEqual(verify.run(self.index, emit=self.logs.append), 1)
                self.assertEqual(len(self.logs), 1)
                self.assertIn("no public request", self.logs[0])
                self.assertNotIn("PRIVATE_MARKER", self.logs[0])
            factory.assert_not_called()

    def test_unreadable_or_oversized_expected_file_fails_before_http(self):
        with mock.patch.object(verify, "make_opener") as factory:
            self.index.unlink()
            self.assertEqual(verify.run(self.index, emit=self.logs.append), 1)
            self.index.write_bytes(b"x" * (verify.MAX_BYTES + 1))
            self.assertEqual(verify.run(self.index, emit=self.logs.append), 1)
            factory.assert_not_called()

    def test_exact_public_url_get_headers_and_bounded_reads(self):
        first, second = Response(homepage(away="Stale")), Response()
        opener = Opener(first, second)
        self.assertEqual(self.run_check(opener), 0)
        for number, (request, timeout) in enumerate(opener.requests, 1):
            self.assertEqual(request.full_url, "https://calbluefc.com/?pages_verify=offline-" + str(number))
            self.assertEqual(request.get_method(), "GET")
            self.assertIsNone(request.data)
            self.assertEqual(timeout, 10)
            headers = {name.lower(): value for name, value in request.header_items()}
            self.assertNotIn("authorization", headers)
            self.assertNotIn("cookie", headers)
            self.assertNotIn("apikey", headers)
            self.assertEqual(headers["accept-encoding"], "identity")
            self.assertEqual(headers["cache-control"], "no-cache")
        self.assertEqual(first.reads, [verify.MAX_BYTES + 1])
        self.assertEqual(second.reads, [verify.MAX_BYTES + 1])

    def test_response_size_limit_checks_headers_and_stream(self):
        announced = Response()
        announced.headers["Content-Length"] = str(verify.MAX_BYTES + 1)
        streamed = Response(b"x" * (verify.MAX_BYTES + 1))
        for response in (announced, streamed):
            opener = Opener(response)
            self.assertEqual(self.run_check(opener), 1)
            self.assertEqual(len(opener.requests), 1)
            self.assertTrue(response.closed)
        self.assertEqual(announced.reads, [])
        self.assertEqual(streamed.reads, [verify.MAX_BYTES + 1])

    def test_network_errors_have_bounded_retries_and_safe_logs(self):
        private = "PRIVATE_TOKEN https://private.test/PRIVATE_BODY"
        opener = Opener(*[urllib.error.URLError(private) for _ in range(12)])
        self.assertEqual(self.run_check(opener), 1)
        self.assertEqual(len(opener.requests), 12)
        self.assertEqual(self.delays, [5] * 11)
        self.assertIn("network_error", self.logs[0])
        self.assertNotIn("PRIVATE", "\n".join(self.logs))
        self.assertNotIn("https://", "\n".join(self.logs))

    def test_transient_http_errors_retry_without_reading_error_bodies(self):
        body = mock.Mock()
        body.read.side_effect = AssertionError("Do not read error bodies")
        error = urllib.error.HTTPError("https://private.test/", 503, "PRIVATE_TOKEN", Message(), body)
        opener = Opener(error, Response())
        self.assertEqual(self.run_check(opener), 0)
        self.assertEqual(self.delays, [5])
        body.read.assert_not_called()
        self.assertTrue(body.close.called)
        self.assertNotIn("PRIVATE", "\n".join(self.logs))
        self.logs.clear()
        self.delays.clear()
        opener = Opener(*[Response(status=503) for _ in range(12)])
        self.assertEqual(self.run_check(opener), 1)
        self.assertEqual(len(opener.requests), 12)
        self.assertEqual(self.delays, [5] * 11)

    def test_redirects_auth_failures_or_changed_origin_stop_safely(self):
        for response in [Response(status=code) for code in (301, 302, 303, 307, 308, 401, 403)]:
            self.delays.clear()
            opener = Opener(response)
            self.assertEqual(self.run_check(opener), 1)
            self.assertEqual(len(opener.requests), 1)
            self.assertEqual(self.delays, [])
            self.assertEqual(response.reads, [])
            self.assertTrue(response.closed)
        for url in ("https://other.test/", "http://calbluefc.com/"):
            response = Response(url=url)
            self.assertEqual(self.run_check(Opener(response)), 1)
            self.assertEqual(response.reads, [])

    def test_invalid_public_html_or_content_type_can_recover(self):
        for response in (Response(b"PRIVATE_BODY"), Response(content_type="application/json"),
                         Response(b"\xff"), Response(homepage().replace(b"data-team-away", b"data-team-home"))):
            self.logs.clear()
            self.delays.clear()
            opener = Opener(response, Response())
            self.assertEqual(self.run_check(opener), 0)
            self.assertEqual(len(opener.requests), 2)
            self.assertEqual(self.delays, [5])
            self.assertNotIn("PRIVATE_BODY", "\n".join(self.logs))

    def test_transport_uses_verified_tls_and_no_proxies_cookies_or_redirects(self):
        with mock.patch.object(urllib.request, "build_opener") as build:
            verify.make_opener()
        handlers = build.call_args.args
        tls = next(handler for handler in handlers if isinstance(handler, urllib.request.HTTPSHandler))
        proxy = next(handler for handler in handlers if isinstance(handler, urllib.request.ProxyHandler))
        redirect = next(handler for handler in handlers if isinstance(handler, verify.NoRedirect))
        self.assertTrue(tls._context.check_hostname)
        self.assertEqual(tls._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(proxy.proxies, {})
        self.assertFalse(any(isinstance(handler, urllib.request.HTTPCookieProcessor) for handler in handlers))
        for code in (301, 302, 303, 307, 308):
            self.assertIsNone(redirect.redirect_request(None, None, code, "PRIVATE", {}, "http://other.test/"))

    def test_factory_unknown_exception_and_sleep_errors_are_redacted(self):
        with mock.patch.object(verify, "make_opener", side_effect=RuntimeError("PRIVATE_TOKEN")):
            self.assertEqual(verify.run(self.index, emit=self.logs.append), 1)
        self.assertEqual(self.run_check(Opener(RuntimeError("PRIVATE_TOKEN"))), 1)
        self.assertEqual(verify.run(self.index, opener=Opener(Response(status=503)), emit=self.logs.append,
                                   sleep=mock.Mock(side_effect=RuntimeError("PRIVATE_TOKEN"))), 1)
        self.assertNotIn("PRIVATE_TOKEN", "\n".join(self.logs))

    def test_cli_defaults_and_bad_arguments_do_not_echo_private_values(self):
        with mock.patch.object(verify, "run", return_value=0) as run:
            self.assertEqual(verify.main([]), 0)
            run.assert_called_once_with(verify.DEFAULT_INDEX)
        with mock.patch.object(verify, "run", return_value=0) as run:
            self.assertEqual(verify.main(["--index", str(self.index)]), 0)
            run.assert_called_once_with(self.index)
        output = io.StringIO()
        with redirect_stdout(output), mock.patch.object(verify, "run") as run:
            self.assertEqual(verify.main(["--url", "PRIVATE_TOKEN"]), 1)
            run.assert_not_called()
        self.assertNotIn("PRIVATE_TOKEN", output.getvalue())


if __name__ == "__main__":
    unittest.main()

"""Deterministic HTTP doubles only: never contact a Supabase project."""

from contextlib import redirect_stdout
from email.message import Message
import http.client
import io
import json
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request

from scripts import check_supabase_activity as activity


KEY = "sb_publishable_" + "a" * 32
SECOND_KEY = "sb_publishable_" + "b" * 32


def config():
    return {"projects": [
        {"label": label, "ref": ref, "publishable_key": key}
        for (label, ref), key in zip(activity.PROJECTS, (KEY, SECOND_KEY))
    ]}


def headers(content_type="application/json"):
    result = Message()
    if content_type is not None:
        result["Content-Type"] = content_type
    return result


class Response:
    def __init__(self, status=200, content_type="application/json", url=None):
        self.status = status
        self.headers = headers(content_type)
        self.url = url
        self.closed = False
        self.body_reads = 0

    def geturl(self):
        return self.url

    def getcode(self):
        return self.status

    def read(self, *arguments):
        self.body_reads += 1
        raise AssertionError("Response bodies must not be read")

    def close(self):
        self.closed = True


class Opener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if not self.responses:
            raise AssertionError("Unexpected request")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            if isinstance(response, urllib.error.HTTPError):
                response.url = request.full_url
            raise response
        if response.url is None:
            response.url = request.full_url
        return response


class SupabaseActivityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "config.json"
        self.path.write_text(json.dumps(config()), encoding="utf-8")
        self.lines = []
        self.delays = []
        # An accidentally un-injected test cannot silently hit the live API.
        self.block_network = mock.patch.object(urllib.request.OpenerDirector, "open",
            side_effect=AssertionError("Live network is forbidden in these tests"))
        self.block_network.start()
        self.addCleanup(self.block_network.stop)

    def run_check(self, opener):
        return activity.run(self.path, opener=opener, sleep=self.delays.append, emit=self.lines.append)

    def test_exact_two_targets_and_headers_are_read_only_and_anonymous(self):
        first, second = Response(), Response(206, "application/json; charset=utf-8")
        opener = Opener(first, second)
        self.assertEqual(self.run_check(opener), 0)
        self.assertEqual(self.lines, ["website: HTTP 200", "verification-test: HTTP 206"])
        self.assertEqual(self.delays, [])
        for index, (request, timeout) in enumerate(opener.calls):
            label, ref = activity.PROJECTS[index]
            self.assertEqual(request.full_url, "https://" + ref + ".supabase.co/rest/v1/games?select=id&limit=1")
            self.assertEqual(request.get_method(), "HEAD")
            self.assertIsNone(request.data)
            self.assertEqual(timeout, 20)
            sent = {name.lower(): value for name, value in request.header_items()}
            self.assertEqual(sent["apikey"], (KEY, SECOND_KEY)[index])
            self.assertEqual(sent["accept"], "application/json")
            self.assertEqual(sent["cache-control"], "no-cache")
            self.assertNotIn("authorization", sent)
            self.assertNotIn("cookie", sent)
            self.assertNotIn("prefer", sent)
        for response in (first, second):
            self.assertTrue(response.closed)
            self.assertEqual(response.body_reads, 0)

    def test_config_order_cannot_change_fixed_request_or_output_order(self):
        source = config()
        source["projects"].reverse()
        self.path.write_text(json.dumps(source), encoding="utf-8")
        self.assertEqual(self.run_check(Opener(Response(), Response())), 0)
        self.assertEqual(self.lines, ["website: HTTP 200", "verification-test: HTTP 200"])

    def test_malformed_and_unexpected_config_never_constructs_a_network_client(self):
        sources = [None, [], {}, {"projects": None}, {"projects": []},
                   {"projects": config()["projects"][:1]}, {**config(), "url": "https://example.test"}]
        for mutation in (
            lambda value: value["projects"].append(value["projects"][0]),
            lambda value: value["projects"].__setitem__(1, value["projects"][0]),
            lambda value: value["projects"][0].update(label="unexpected"),
            lambda value: value["projects"][0].update(ref=activity.PROJECTS[1][1]),
            lambda value: value["projects"][0].update(ref="rmksoklavpoartewjvus.example.test"),
            lambda value: value["projects"][0].update(ref="https://rmksoklavpoartewjvus.supabase.co"),
            lambda value: value["projects"][0].update(ref="rmksoklavpoartewjvus@evil.test"),
            lambda value: value["projects"][0].update(label=[]),
            lambda value: value["projects"][0].update(publishable_key=None),
            lambda value: value["projects"][0].update(url="https://example.test"),
            lambda value: value["projects"][0].pop("ref"),
        ):
            value = config()
            mutation(value)
            sources.append(value)
        with mock.patch.object(activity, "make_opener", side_effect=AssertionError("Must validate first")) as factory:
            for source in sources:
                with self.subTest(source=type(source).__name__):
                    self.path.write_text(json.dumps(source), encoding="utf-8")
                    self.lines.clear()
                    self.assertEqual(activity.run(self.path, emit=self.lines.append), 1)
                    self.assertEqual(self.lines, ["configuration: invalid_config"])
            factory.assert_not_called()

    def test_secret_tokens_legacy_jwts_headers_and_unbounded_keys_are_rejected(self):
        for key in ["sb_" + "secret_" + "x" * 32, "eyJhbGciOiJIUzI1NiJ9.payload.signature", "Bearer SECRET",
                    "sb_publishable_short", KEY + "\nAuthorization: secret", KEY + " ", "sb_publishable_" + "x" * 129]:
            source = config()
            source["projects"][1]["publishable_key"] = key
            self.path.write_text(json.dumps(source), encoding="utf-8")
            opener = Opener()
            self.assertEqual(self.run_check(opener), 1)
            self.assertEqual(opener.calls, [])
            self.assertNotIn(key, "\n".join(self.lines))

    def test_invalid_bytes_duplicate_json_keys_and_oversized_config_are_rejected(self):
        valid = json.dumps(config())
        inputs = [b"\xff", b"{", b" ".join([b"["] * 1100), b"x" * (activity.MAX_CONFIG_BYTES + 1),
                  b'{"projects":[],"projects":[]}',
                  valid.replace('"label": "website"', '"label":"unexpected","label":"website"').encode()]
        for data in inputs:
            with self.subTest(length=len(data)):
                self.path.write_bytes(data)
                opener = Opener()
                self.assertEqual(self.run_check(opener), 1)
                self.assertEqual(opener.calls, [])
        self.path.unlink()
        self.assertEqual(self.run_check(Opener()), 1)

    def test_config_read_is_bounded_to_one_byte_beyond_the_limit(self):
        stream = mock.MagicMock()
        stream.__enter__.return_value.read.return_value = b"x" * (activity.MAX_CONFIG_BYTES + 1)
        with mock.patch.object(Path, "open", return_value=stream):
            self.assertEqual(self.run_check(Opener()), 1)
        stream.__enter__.return_value.read.assert_called_once_with(activity.MAX_CONFIG_BYTES + 1)

    def test_terminal_http_errors_never_retry_and_always_check_the_second_project(self):
        for status in [204, 301, 302, 303, 307, 308, 400, 401, 403, 404, 409]:
            with self.subTest(status=status):
                opener = Opener(Response(status), Response())
                self.lines.clear()
                self.delays.clear()
                self.assertEqual(self.run_check(opener), 1)
                self.assertEqual(len(opener.calls), 2)
                self.assertEqual(self.delays, [])
                self.assertEqual(self.lines, ["website: HTTP " + str(status), "verification-test: HTTP 200"])

    def test_retryable_statuses_get_at_most_two_attempts_and_two_seconds_delay(self):
        for status in [408, 429, 500, 502, 503, 504, 599]:
            with self.subTest(status=status):
                first, retry, second = Response(status, "text/html"), Response(status), Response()
                opener = Opener(first, retry, second)
                self.lines.clear()
                self.delays.clear()
                self.assertEqual(self.run_check(opener), 1)
                self.assertEqual(len(opener.calls), 3)
                self.assertEqual(self.delays, [2])
                self.assertEqual(self.lines, ["website: HTTP " + str(status), "verification-test: HTTP 200"])
                self.assertTrue(first.closed and retry.closed and second.closed)

    def test_transient_errors_can_recover_and_both_projects_have_independent_retry_budgets(self):
        opener = Opener(Response(503), Response(), Response(429), Response(206))
        self.assertEqual(self.run_check(opener), 0)
        self.assertEqual(len(opener.calls), 4)
        self.assertEqual(self.delays, [2, 2])
        self.assertEqual(self.lines, ["website: HTTP 200", "verification-test: HTTP 206"])

    def test_network_exceptions_retry_without_echoing_keys_urls_or_exception_text(self):
        private = KEY + " https://example.test/PRIVATE response body"
        failures = [urllib.error.URLError(private), TimeoutError(private), OSError(private),
                    ssl.SSLError(private), http.client.RemoteDisconnected(private)]
        for error in failures:
            with self.subTest(kind=type(error).__name__):
                self.lines.clear()
                self.delays.clear()
                opener = Opener(error, error, Response())
                self.assertEqual(self.run_check(opener), 1)
                self.assertEqual(self.lines, ["website: network_error", "verification-test: HTTP 200"])
                self.assertEqual(self.delays, [2])
                self.assertEqual(len(opener.calls), 3)

    def test_unexpected_exception_is_redacted_and_does_not_skip_second_project(self):
        opener = Opener(RuntimeError(KEY + " PRIVATE BODY"), Response())
        self.assertEqual(self.run_check(opener), 1)
        self.assertEqual(self.lines, ["website: request_error", "verification-test: HTTP 200"])
        self.assertEqual(self.delays, [])

    def test_bad_json_content_type_does_not_retry_or_read_body(self):
        for content_type in [None, "text/html", "text/plain", "application/problem+json", "application/json" + "x" * 130]:
            response = Response(content_type=content_type)
            opener = Opener(response, Response())
            self.lines.clear()
            self.delays.clear()
            self.assertEqual(self.run_check(opener), 1)
            self.assertEqual(self.lines, ["website: invalid_content_type", "verification-test: HTTP 200"])
            self.assertEqual(len(opener.calls), 2)
            self.assertEqual(self.delays, [])
            self.assertEqual(response.body_reads, 0)
            self.assertTrue(response.closed)
        response = Response()
        response.headers["Content-Type"] = "application/json"
        self.assertEqual(self.run_check(Opener(response, Response())), 1)

    def test_json_media_type_is_case_insensitive_and_allows_charset(self):
        self.assertEqual(self.run_check(Opener(Response(content_type="Application/JSON; charset=UTF-8"), Response())), 0)

    def test_http_error_statuses_are_inspected_without_reading_or_logging_error_body(self):
        for status, count in [(403, 1), (302, 1), (503, 2)]:
            body = mock.Mock()
            body.read.side_effect = AssertionError("Never read error bodies")
            error = urllib.error.HTTPError("https://example.test/PRIVATE", status, KEY + " PRIVATE REASON", headers("text/html"), body)
            opener = Opener(*([error] * count), Response())
            self.lines.clear()
            self.delays.clear()
            self.assertEqual(self.run_check(opener), 1)
            self.assertEqual(self.lines, ["website: HTTP " + str(status), "verification-test: HTTP 200"])
            body.read.assert_not_called()
            self.assertTrue(body.close.called)

    def test_changed_response_origin_and_invalid_status_never_become_success(self):
        for response in [Response(url="https://example.test/redirect"), Response(status="SECRET"), Response(status=True), Response(status=999)]:
            self.lines.clear()
            self.assertEqual(self.run_check(Opener(response, Response())), 1)
            self.assertEqual(self.lines, ["website: invalid_response", "verification-test: HTTP 200"])

    def test_opener_uses_verified_tls_no_proxy_cookies_authorization_or_redirects(self):
        with mock.patch.object(urllib.request, "build_opener") as build:
            activity.make_opener()
        handlers = build.call_args.args
        proxy = next(item for item in handlers if isinstance(item, urllib.request.ProxyHandler))
        tls = next(item for item in handlers if isinstance(item, urllib.request.HTTPSHandler))
        redirect = next(item for item in handlers if isinstance(item, activity.NoRedirect))
        self.assertEqual(proxy.proxies, {})
        self.assertTrue(tls._context.check_hostname)
        self.assertEqual(tls._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertFalse(any(isinstance(item, urllib.request.HTTPCookieProcessor) for item in handlers))
        for code in [301, 302, 303, 307, 308]:
            request = urllib.request.Request("https://example.test/", method="HEAD", headers={"apikey": KEY})
            self.assertIsNone(redirect.redirect_request(request, None, code, "PRIVATE", headers(), "https://other.test/"))

    def test_standard_redirect_handler_never_opens_destination_or_drains_body(self):
        redirect = activity.NoRedirect()
        redirect.parent = mock.Mock()
        for code in [301, 302, 303, 307, 308]:
            handler = getattr(redirect, "http_error_" + str(code), None)
            if handler is None:
                # Older Python versions use the default HTTPError path for308.
                continue
            body = mock.Mock()
            response_headers = headers("text/html")
            response_headers["Location"] = "https://other.test/PRIVATE"
            request = urllib.request.Request("https://example.test/", method="HEAD", headers={"apikey": KEY})
            self.assertIsNone(handler(request, body, code, "PRIVATE", response_headers))
            body.read.assert_not_called()
            redirect.parent.open.assert_not_called()

    def test_setup_failure_and_sleep_failure_are_safe_and_preserve_project_reporting(self):
        with mock.patch.object(activity, "make_opener", side_effect=RuntimeError(KEY)):
            self.assertEqual(activity.run(self.path, emit=self.lines.append), 1)
        self.assertEqual(self.lines, ["website: request_error", "verification-test: request_error"])
        self.lines.clear()
        opener = Opener(Response(503), Response())
        self.assertEqual(activity.run(self.path, opener=opener, emit=self.lines.append,
            sleep=mock.Mock(side_effect=RuntimeError(KEY))), 1)
        self.assertEqual(self.lines, ["website: request_error", "verification-test: HTTP 200"])

    def test_cli_rejects_unknown_key_arguments_without_echoing_them(self):
        for arguments in [["--key", KEY], ["--config"], ["--config", "PRIVATE", "--url", "https://example.test"]]:
            output = io.StringIO()
            with redirect_stdout(output), mock.patch.object(activity, "run") as run:
                self.assertEqual(activity.main(arguments), 1)
                run.assert_not_called()
            self.assertEqual(output.getvalue(), "configuration: invalid_arguments\n")

    def test_cli_uses_default_or_fixture_config_without_key_arguments(self):
        with mock.patch.object(activity, "run", return_value=0) as run:
            self.assertEqual(activity.main([]), 0)
            run.assert_called_once_with(activity.DEFAULT_CONFIG)
        with mock.patch.object(activity, "run", return_value=1) as run:
            self.assertEqual(activity.main(["--config", str(self.path)]), 1)
            run.assert_called_once_with(self.path)


if __name__ == "__main__":
    unittest.main()

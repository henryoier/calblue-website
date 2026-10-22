import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("send_club_reminders", ROOT / "scripts/send_club_reminders.py")
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)

class FakeSMTP:
    def __init__(self, fail=False):
        self.messages = []
        self.fail = fail
    def send_message(self, message, **kwargs):
        self.messages.append((message, kwargs))
        if self.fail:
            raise OSError("Synthetic uncertain connection")
        return {}

class ReminderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = sender.ledger(Path(self.temp.name) / "receipts.sqlite3")
        self.rows = [{"invoice_id": "synthetic-invoice", "to": "player@example.com", "subject": "Test dues", "body": "Synthetic reminder."}]
    def tearDown(self):
        self.db.close()
        self.temp.cleanup()
    def test_suppresses_repeated_batch(self):
        smtp = FakeSMTP()
        self.assertEqual(sender.send_batch(self.rows, smtp, "club@example.com", self.db), (1, 0))
        self.assertEqual(sender.send_batch(self.rows, smtp, "club@example.com", self.db), (0, 1))
        self.assertEqual(len(smtp.messages), 1)
    def test_uncertain_outcome_cannot_auto_retry(self):
        with self.assertRaises(RuntimeError):
            sender.send_batch(self.rows, FakeSMTP(fail=True), "club@example.com", self.db)
        smtp = FakeSMTP()
        self.assertEqual(sender.send_batch(self.rows, smtp, "club@example.com", self.db), (0, 1))
        self.assertEqual(smtp.messages, [])
    def test_header_injection_and_multiple_recipients(self):
        for value in ["a@example.com\nBcc: x@example.com", "a@example.com,b@example.com"]:
            with self.assertRaises(ValueError):
                sender.email_address(value)
    def test_ledger_rejected_under_served_repository(self):
        with self.assertRaises(ValueError):
            sender.ledger(ROOT / "receipts.sqlite3")

class OfficeAssetsTests(unittest.TestCase):
    def test_all_static_imports_and_assets_exist(self):
        import re
        for source in (ROOT / "club-office").glob("*.js"):
            for relative in re.findall(r'from\s+"([.][^\"]+)"', source.read_text()):
                self.assertTrue((source.parent / relative).is_file(), (source, relative))
    def test_private_office_has_no_external_connections(self):
        for name in ["index.html", "register.html", "pay.html"]:
            source = (ROOT / "club-office" / name).read_text()
            self.assertIn("connect-src 'none'", source)
            self.assertIn("form-action 'none'", source)
            self.assertNotIn("https://", source)

if __name__ == "__main__":
    unittest.main()

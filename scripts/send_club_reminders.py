#!/usr/bin/env python3
"""Preview an exported reminder batch; send only with explicit --send over SMTP TLS.

No bank credentials. Password comes from CALBLUE_SMTP_PASSWORD or a hidden prompt.
The external receipt ledger suppresses duplicate batches and uncertain retries.
SMTP acceptance is not delivery or payment verification.
"""
import argparse
import csv
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import make_msgid
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import smtplib
import sqlite3
import ssl

ROOT = Path(__file__).resolve().parents[1]

def email_address(value):
    if not isinstance(value, str) or not re.fullmatch(r"[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+", value):
        raise ValueError("Use exactly one valid mailbox address.")
    return value

def read_batch(path):
    if path.stat().st_size > 5 * 1024 * 1024:
        raise ValueError("Batch is too large.")
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != ["invoice_id", "to", "subject", "body"]:
            raise ValueError("Use a reminder batch exported by Club office.")
        rows = list(reader)
    for row in rows:
        if set(row) != {"invoice_id", "to", "subject", "body"} or any(not isinstance(v, str) or not v for v in row.values()):
            raise ValueError("Incomplete reminder row.")
        email_address(row["to"])
        if "\n" in row["subject"] or "\r" in row["subject"] or len(row["subject"]) > 300 or len(row["body"]) > 12000:
            raise ValueError("Invalid subject or message length.")
    if len({row["invoice_id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate invoice in batch.")
    return rows

def message_key(row):
    return hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()

def ledger(path):
    path = path.expanduser().resolve()
    if path.is_relative_to(ROOT):
        raise ValueError("Receipt ledger must be outside the repository and any served web directory.")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    os.chmod(path, 0o600)
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE IF NOT EXISTS receipts (message_key TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)")
    db.commit()
    return db

def send_batch(rows, smtp, sender, db):
    accepted = skipped = 0
    for row in rows:
        key = message_key(row)
        # Atomically reserve before calling SMTP; a crash may have sent the message.
        try:
            db.execute("INSERT INTO receipts VALUES (?, 'pending', ?)", (key, datetime.now(timezone.utc).isoformat()))
            db.commit()
        except sqlite3.IntegrityError:
            skipped += 1
            continue
        message = EmailMessage()
        message["From"] = sender
        message["To"] = row["to"]
        message["Subject"] = row["subject"]
        message["Message-ID"] = make_msgid(domain=sender.split("@", 1)[1])
        message.set_content(row["body"])
        try:
            rejected = smtp.send_message(message, from_addr=sender, to_addrs=[row["to"]])
            if rejected:
                raise RuntimeError("Recipient rejected; inspect SMTP provider logs before retrying.")
        except Exception:
            # Retain pending: do not blindly retry an ambiguous SMTP outcome.
            raise RuntimeError("Send outcome is uncertain or rejected. The receipt is held as pending; check provider logs before any retry.") from None
        db.execute("UPDATE receipts SET state='accepted', updated_at=? WHERE message_key=?", (datetime.now(timezone.utc).isoformat(), key))
        db.commit()
        accepted += 1
    return accepted, skipped

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batch", type=Path)
    parser.add_argument("--send", action="store_true", help="Explicitly send the reviewed batch")
    parser.add_argument("--from-address")
    parser.add_argument("--smtp-host")
    parser.add_argument("--smtp-port", type=int, default=465)
    parser.add_argument("--smtp-user")
    parser.add_argument("--starttls", action="store_true", help="Use STARTTLS, usually with port 587")
    parser.add_argument("--ledger", type=Path)
    args = parser.parse_args()
    rows = read_batch(args.batch)
    if not args.send:
        for row in rows:
            print(f"To: {row['to']}\nSubject: {row['subject']}\n\n{row['body']}\n")
        print(f"PREVIEW ONLY: {len(rows)} reminders. No network connection or emails sent.")
        return
    if not all([args.from_address, args.smtp_host, args.smtp_user, args.ledger]):
        parser.error("--send requires --from-address, --smtp-host, --smtp-user and --ledger")
    sender = email_address(args.from_address)
    db = ledger(args.ledger)
    password = os.environ.get("CALBLUE_SMTP_PASSWORD") or getpass.getpass("SMTP password / app password: ")
    context = ssl.create_default_context()
    connection = smtplib.SMTP(args.smtp_host, args.smtp_port, timeout=30) if args.starttls else smtplib.SMTP_SSL(args.smtp_host, args.smtp_port, context=context, timeout=30)
    try:
        if args.starttls:
            connection.ehlo()
            connection.starttls(context=context)
            connection.ehlo()
        connection.login(args.smtp_user, password)
        accepted, skipped = send_batch(rows, connection, sender, db)
        print(f"SMTP accepted: {accepted}; suppressed as already attempted: {skipped}. Delivery is not confirmed.")
    finally:
        db.close()
        connection.close()

if __name__ == "__main__":
    main()

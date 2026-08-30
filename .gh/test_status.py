#!/usr/bin/env python3
"""Unit tests for issue-reference parsing in status.py."""

import sys
import unittest

sys.path.insert(0, ".gh")
import status  # noqa: E402


class LinkedNumbersTests(unittest.TestCase):
    def test_single_closing_reference(self):
        self.assertEqual(
            list(status.linked_numbers("Closes #29.", status.RESOLVES)),
            ["29"],
        )

    def test_markdown_bullet_and_bold_metadata(self):
        self.assertEqual(
            list(status.linked_numbers("- Closes #29.", status.RESOLVES)),
            ["29"],
        )
        self.assertEqual(
            list(status.linked_numbers("**Resolves #68** · base: #62", status.RESOLVES)),
            ["68"],
        )

    def test_comma_separated_closing_references(self):
        self.assertEqual(
            list(status.linked_numbers("Resolves #31, #32", status.RESOLVES)),
            ["31", "32"],
        )

    def test_and_separated_part_references(self):
        self.assertEqual(
            list(status.linked_numbers("Part of #24 and #27", status.PARTOF)),
            ["24", "27"],
        )

    def test_clause_stops_before_unrelated_metadata(self):
        self.assertEqual(
            list(status.linked_numbers(
                "Resolves #68 · base: #62 · tracking: #58",
                status.RESOLVES,
            )),
            ["68"],
        )

    def test_line_without_keyword_has_no_links(self):
        self.assertEqual(
            list(status.linked_numbers("See #31 and #32", status.RESOLVES)),
            [],
        )

    def test_explanatory_sentence_is_not_metadata(self):
        self.assertEqual(
            list(status.linked_numbers(
                "Parse clauses such as Resolves #31, #32",
                status.RESOLVES,
            )),
            [],
        )


class ActivePullRequestTests(unittest.TestCase):
    def test_closed_unmerged_pr_does_not_satisfy_dependency(self):
        links = {29: [({"state": "closed", "merged_at": None}, "resolves")]}
        self.assertFalse(status.has_active_pr(29, links))

    def test_open_or_merged_pr_satisfies_dependency(self):
        open_links = {29: [({"state": "open", "merged_at": None}, "resolves")]}
        merged_links = {
            29: [({"state": "closed", "merged_at": "2026-08-30T00:00:00Z"}, "resolves")]
        }
        self.assertTrue(status.has_active_pr(29, open_links))
        self.assertTrue(status.has_active_pr(29, merged_links))


if __name__ == "__main__":
    unittest.main()

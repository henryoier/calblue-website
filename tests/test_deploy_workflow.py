"""The deploy workflow's publication steps, read as text: the standard library has no YAML parser."""

import re
import unittest
from pathlib import Path


WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "deploy.yml"
RETRY_ONLY = "if: steps.deployment.outcome == 'failure'"
DEPLOY_ACTION = "uses: actions/deploy-pages@v4"
PUBLICATION = [
    "Upload static site",
    "Wait for uploaded Pages artifact to become visible",
    "Deploy",
    "Wait before a second deploy attempt",
    "Deploy (second attempt)",
    "Verify the public homepage match details",
]


def steps(text):
    """[(name, body)] for the job's steps, in file order."""
    parts = re.split(r"(?m)^      - name: (.+)$", text)
    return [(parts[index].strip(), parts[index + 1]) for index in range(1, len(parts), 2)]


def settings(body):
    """The step's own keys and values, without comment lines."""
    return [line.strip() for line in body.splitlines() if line.strip() and not line.strip().startswith("#")]


class DeployWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.steps = steps(cls.text)
        cls.by_name = dict(cls.steps)

    def test_publication_steps_follow_each_other_in_this_order(self):
        names = [name for name, _ in self.steps]
        first = names.index(PUBLICATION[0])
        self.assertEqual(names[first:first + len(PUBLICATION)], PUBLICATION)
        self.assertEqual(len(self.by_name), len(self.steps), "step names must be unique")

    def test_a_failed_first_attempt_does_not_end_the_run(self):
        first = settings(self.by_name["Deploy"])
        self.assertIn("id: deployment", first)
        self.assertIn("continue-on-error: true", first)
        self.assertIn(DEPLOY_ACTION, first)
        self.assertFalse([line for line in first if line.startswith("if:")], "the first attempt always runs")

    def test_the_second_attempt_runs_only_after_a_failed_first_one(self):
        pause = settings(self.by_name["Wait before a second deploy attempt"])
        second = settings(self.by_name["Deploy (second attempt)"])
        for step in (pause, second):
            self.assertIn(RETRY_ONLY, step)
        self.assertIn("sleep 30", pause)
        self.assertIn("id: deployment_retry", second)
        self.assertIn(DEPLOY_ACTION, second)

    def test_a_failed_second_attempt_fails_the_run(self):
        second = settings(self.by_name["Deploy (second attempt)"])
        self.assertFalse([line for line in second if line.startswith("continue-on-error")])
        # The only step whose failure is tolerated is the first attempt.
        self.assertEqual(self.text.count("continue-on-error"), 1)

    def test_there_are_never_more_than_two_attempts_and_one_upload(self):
        self.assertEqual(self.text.count(DEPLOY_ACTION), 2)
        self.assertEqual(self.text.count("uses: actions/upload-pages-artifact@"), 1)
        self.assertEqual(self.text.count(RETRY_ONLY), 2)

    def test_the_public_page_is_verified_after_either_attempt(self):
        verify = settings(self.by_name["Verify the public homepage match details"])
        self.assertIn("run: python3 scripts/verify_public_homepage.py", verify)
        # No condition: it runs whenever the job has not failed, which covers both attempts.
        self.assertFalse([line for line in verify if line.startswith(("if:", "continue-on-error"))])

    def test_the_environment_link_comes_from_whichever_attempt_published(self):
        self.assertIn(
            "url: ${{ steps.deployment.outputs.page_url || steps.deployment_retry.outputs.page_url }}", self.text)


if __name__ == "__main__":
    unittest.main()

"""Expose the directly runnable scanner suite to the repository's unittest discovery."""

from scripts.test_check_secrets import RepositoryScannerTest, SecretScannerTest  # noqa: F401

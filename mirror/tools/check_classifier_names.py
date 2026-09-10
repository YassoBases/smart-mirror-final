"""Reject stale classifier names except documented compatibility and archives."""
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[2]
# These are the only active files allowed to mention legacy names.
allowed = {
    "mirror/services/wardrobe_attr/README.md",
    "mirror/services/wardrobe_attr/serve_clip.py",
    "mirror/services/wardrobe_attr/tests/test_service_config.py",
    "mirror/backend/lib/wardrobe_attr_client.js",
    "mirror/backend/__tests__/classifier.config.test.js",
    "mirror/backend/jest.setup.js",
    "mirror/tools/seed_demo_wardrobe.js",
}
bad = []
for name in subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=root, text=True).splitlines():
    if name.startswith("app/") or "/_archive_blip2/" in name or name in allowed:
        continue
    p = root/name
    if not p.is_file():
        continue
    try:
        content = p.read_text(encoding="utf-8")
    except UnicodeError:
        continue
    for number, line in enumerate(content.splitlines(), 1):
        if re.search(r"blip[-_]?2", line, re.I) and "_archive_blip2/" not in line:
            bad.append(f"{name}:{number}")
if bad:
    raise SystemExit("Unexpected legacy references:\n" + "\n".join(bad))
print("Classifier names: only documented compatibility/archive references remain")

"""Create issues from a spec module. Idempotent: skips titles that already exist."""
import json, sys
sys.path.insert(0, '.gh')
from api import api

def existing_titles():
    titles = {}
    page = 1
    while True:
        batch = api("GET", f"/issues?state=all&per_page=100&page={page}")
        if not isinstance(batch, list) or not batch:
            break
        for i in batch:
            titles[i["title"]] = i["number"]
        page += 1
    return titles

def run(module_name):
    mod = __import__(module_name)
    ms = {m["title"]: m["number"] for m in api("GET", "/milestones?state=all")}
    have = existing_titles()
    created = {}
    for slug, milestone, labels, title, body in mod.ISSUES:
        if title in have:
            print(f"  = #{have[title]:<3} {title[:64]} (exists)")
            created[slug] = have[title]
            continue
        r = api("POST", "/issues", {
            "title": title, "body": body.strip(),
            "labels": labels, "milestone": ms.get(milestone)})
        num = r.get("number")
        created[slug] = num
        print(f"  + #{num!s:<3} {title[:64]}" if num else f"  ! FAILED {title}: {r.get('message')}")
    return created

if __name__ == "__main__":
    out = run(sys.argv[1])
    path = "/tmp/issue_numbers.json"
    try:
        prev = json.load(open(path))
    except Exception:
        prev = {}
    prev.update({k: v for k, v in out.items() if v})
    json.dump(prev, open(path, "w"))
    print(f"\n{len([v for v in out.values() if v])} issues resolved -> {path}")

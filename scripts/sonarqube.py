import glob
import json
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict

# --- SonarQube connection settings ---
SONAR_HOST = "https://sonarqube.superak0s.com"


def read_env_var(name: str) -> str:
    """Read name from the repo-root .env (plain KEY=VALUE lines), else the process env."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                key, sep, val = line.strip().partition("=")
                if sep and key.strip() == name:
                    return val.strip().strip("\"'")
    return os.environ.get(name, "")


SONAR_USER_TOKEN = read_env_var("SONAR_USER_TOKEN") or sys.exit("SONAR_USER_TOKEN missing from .env")
COMPONENT_KEY = "OwnGains-Server"
IMPACT_SEVERITIES = "HIGH,MEDIUM,LOW"
ISSUE_STATUSES = "CONFIRMED,OPEN"
PAGE_SIZE = 500

BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sonarqube")
os.makedirs(BASE_DIR, exist_ok=True)
PART_FILES = []  # filled by the fetch step, one file per page
MERGED_FILE = os.path.join(BASE_DIR, "all_severities.json")  # merged output
OUTPUT_DIR = os.path.join(BASE_DIR, "all_severities")  # root output folder for split files
MAX_LINES = 2000

FIELDS_TO_REMOVE = {
    "key",
    "hash",
    "project",
    "effort",
    "debt",
    "author",
    "tags",
    "creationDate",
    "updateDate",
    "scope",
    "messageFormattings",
    "codeVariants",
    "cleanCodeAttribute",
    "cleanCodeAttributeCategory",
    "linkedTicketStatus",
    "internalTags",
    "fromSonarQubeUpdate",
    "prioritizedRule",
    "quickFixAvailable",
    "impacts",
    "issueStatus",
    "status",
}


def strip_empty(obj):
    """
    Recursively remove keys/items that are 'empty' (None, "", [], {}).
    Works in-place on dicts/lists and returns the cleaned object.
    """
    if isinstance(obj, dict):
        cleaned = {}
        for k, v in obj.items():
            v = strip_empty(v)
            if v is None or v == "" or v == [] or v == {}:
                continue
            cleaned[k] = v
        return cleaned
    if isinstance(obj, list):
        cleaned_list = []
        for item in obj:
            item = strip_empty(item)
            if item is None or item == "" or item == [] or item == {}:
                continue
            cleaned_list.append(item)
        return cleaned_list
    return obj


def fetch_page(page: int, out_file: str):
    """Run the equivalent curl command for one page and save to out_file."""
    url = (
        f"{SONAR_HOST}/api/issues/search"
        f"?componentKeys={COMPONENT_KEY}"
        f"&impactSeverities={IMPACT_SEVERITIES}"
        f"&issueStatuses={ISSUE_STATUSES}"
        f"&ps={PAGE_SIZE}&p={page}"
    )
    cmd = [
        "curl",
        "-u",
        f"{SONAR_USER_TOKEN}:",
        url,
        "-o",
        out_file,
        "-s",
        "-w",
        "%{http_code}",
    ]
    print(f"Fetching page {page} -> {out_file}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    http_code = result.stdout.strip()
    if result.returncode != 0:
        raise RuntimeError(f"curl failed for page {page}: {result.stderr}")
    if http_code and http_code != "200":
        raise RuntimeError(
            f"Page {page} request returned HTTP {http_code}. Check host/token/URL."
        )
    print(f"  -> saved {out_file} (HTTP {http_code})")


def cleanup_previous_run():
    """Delete leftovers from a previous run: part files, merged file, output dir."""
    removed = []
    for f in glob.glob(os.path.join(BASE_DIR, "all_p*.json")) + [MERGED_FILE]:
        if os.path.exists(f):
            os.remove(f)
            removed.append(f)
    if os.path.isdir(OUTPUT_DIR):
        shutil.rmtree(OUTPUT_DIR)
        removed.append(OUTPUT_DIR + "/")
    if removed:
        print("Cleaned up leftovers from previous run:")
        for r in removed:
            print(f"  - removed {r}")
        print()


cleanup_previous_run()

# --- Step 0: Fetch all pages via curl ---
page = 1
while True:
    out_file = os.path.join(BASE_DIR, f"all_p{page}.json")
    fetch_page(page, out_file)
    PART_FILES.append(out_file)
    with open(out_file, encoding="utf-8") as f:
        issue_total = json.load(f)["paging"]["total"]
    if page * PAGE_SIZE >= min(issue_total, 10000):  # SonarQube won't page past 10k results
        break
    page += 1
if issue_total > 10000:
    print(f"WARNING: {issue_total} issues match but SonarQube only returns the first 10000.")
print()


def sanitize_segment(name: str) -> str:
    """Sanitize a single path segment (folder or filename part)."""
    name = re.sub(r"[^A-Za-z0-9_.\-]", "_", name)
    return name.strip("_") or "_"


GROUP_ANCHORS = [
    "features",
    "shared",
    "utils",
]  # segments after which the next folder name is used for grouping


def component_to_folder_and_filename(component: str):
    """
    Turn 'OwnGains-App:src/features/settings/components/EditWorkoutHistoryModal.tsx'
    into ('features/settings', 'EditWorkoutHistoryModal.tsx').

    Turn 'OwnGains-App:src/shared/hooks/useWorkout.ts'
    into ('shared/hooks', 'useWorkout.ts').

    Rule: if the path contains any segment listed in GROUP_ANCHORS
    (e.g. 'features', 'shared'), group under '<anchor>/<name>', where
    <name> is the folder right after the *first* such anchor found,
    regardless of nesting depth. Otherwise (e.g. top-level files like
    'App.tsx'), group under 'root'. The filename is always just the
    last path segment (the actual file).
    """

    comp = component.split(":", 1)[-1] if ":" in component else component
    parts = [p for p in comp.split("/") if p]
    if not parts:
        return "root", "unknown"

    filename = sanitize_segment(parts[-1])

    for anchor in GROUP_ANCHORS:
        if anchor in parts:
            idx = parts.index(anchor)
            anchor_clean = sanitize_segment(anchor)
            if idx + 1 < len(parts):
                candidate = parts[idx + 1]
                if candidate != parts[-1]:
                    return f"{anchor_clean}/{sanitize_segment(candidate)}", filename
                else:
                    # anchor's immediate child IS the file itself (e.g. shared/File.tsx)
                    return anchor_clean, filename

    return "root", filename


def line_count(obj) -> int:
    return json.dumps(obj, indent=2).count("\n") + 1


def write_file(path: str, chunk: list) -> int:
    out = {"total": len(chunk), "issues": chunk}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    lines = line_count(out)
    print(f"Wrote {path} with {len(chunk)} issues ({lines} lines)")
    return lines


# --- Step 1: Merge the paginated files ---
merged_issues = []
seen_keys = set()
dupes_skipped = 0

for part_file in PART_FILES:
    if not os.path.exists(part_file):
        print(f"WARNING: {part_file} not found, skipping.")
        continue
    with open(part_file, "r", encoding="utf-8") as f:
        part_data = json.load(f)
    part_issues = part_data.get("issues", [])
    for issue in part_issues:
        # de-dupe by issue key in case pages overlapped
        k = issue.get("key")
        if k is not None and k in seen_keys:
            dupes_skipped += 1
            continue
        if k is not None:
            seen_keys.add(k)
        merged_issues.append(issue)
    print(f"Read {len(part_issues)} issues from {part_file}")

if dupes_skipped:
    print(f"Skipped {dupes_skipped} duplicate issue(s) found across pages.")

with open(MERGED_FILE, "w", encoding="utf-8") as f:
    json.dump({"total": len(merged_issues), "issues": merged_issues}, f, indent=2)
print(f"\nMerged into {MERGED_FILE}: {len(merged_issues)} total issues\n")

# --- Step 2: Strip unwanted fields, then strip empty/null leftovers ---
cleaned_issues = []
for issue in merged_issues:
    for field in FIELDS_TO_REMOVE:
        issue.pop(field, None)
    cleaned_issues.append(strip_empty(issue))
merged_issues = cleaned_issues

total = len(merged_issues)

# --- Step 3: Group issues by component, preserving first-seen order ---
groups_by_component = defaultdict(list)
component_order = []
for issue in merged_issues:
    comp = issue.get("component", "__unknown__")
    if comp not in groups_by_component:
        component_order.append(comp)
    groups_by_component[comp].append(issue)

os.makedirs(OUTPUT_DIR, exist_ok=True)
files_written = 0

for comp in component_order:
    comp_issues = groups_by_component[comp]
    folder, filename = component_to_folder_and_filename(comp)
    folder_path = os.path.join(OUTPUT_DIR, folder)

    chunks = []
    current = []
    for issue in comp_issues:
        trial = current + [issue]
        if current and line_count({"total": len(trial), "issues": trial}) > MAX_LINES:
            chunks.append(current)
            current = [issue]
        else:
            current = trial
    if current:
        chunks.append(current)

    if len(chunks) == 1:
        path = os.path.join(folder_path, f"all_{filename}.json")
        write_file(path, chunks[0])
        files_written += 1
    else:
        for idx, chunk in enumerate(chunks, start=1):
            path = os.path.join(folder_path, f"all_{filename}_part{idx}.json")
            write_file(path, chunk)
            files_written += 1

print(
    f"\nTotal issues: {total} across {len(component_order)} components, "
    f"written into {files_written} file(s), max {MAX_LINES} lines each"
)

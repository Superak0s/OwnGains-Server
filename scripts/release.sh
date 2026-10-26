#!/usr/bin/env bash
# The brace group makes bash parse the whole file before running anything, so
# editing this script during the multi-minute build can't change what runs next.
{
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
DOCKER_IMAGE="superak0s/owngains-server"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    B=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GRN=$'\e[32m' YEL=$'\e[33m' CYN=$'\e[36m' R=$'\e[0m'
else
    B='' DIM='' RED='' GRN='' YEL='' CYN='' R=''
fi
step() { printf '\n%s==> [%s] %s %s(%dm%02ds)%s\n' "$B$CYN" "$1" "$2" "$DIM" $((SECONDS / 60)) $((SECONDS % 60)) "$R"; }
ok()   { printf '%s  OK  %s%s\n' "$GRN" "$*" "$R"; }
info() { printf '%s  ..  %s%s\n' "$DIM" "$*" "$R"; }
warn() { printf '%s  !!  %s%s\n' "$YEL" "$*" "$R"; }
err()  { printf '%s%sERROR:%s%s %s%s\n' "$B" "$RED" "$R" "$RED" "$*" "$R" >&2; }
die()  { err "$@"; exit 1; }
yn()   { [ "$1" = true ] && printf '%syes%s' "$GRN" "$R" || printf '%sno%s' "$YEL" "$R"; }

usage() {
    cat <<EOF
${B}Usage:${R} scripts/release.sh [options]

  ${CYN}--no-push${R}         Skip the git commit/push/tag/GitHub release. The image is
                    still built and pushed, and the version bump stays local and uncommitted.
  ${CYN}--no-test${R}         Skip the local CI run (act) in the pre-build verification.
                    Typecheck still runs.
  ${CYN}--no-docker-push${R}  Build the image but don't push it to Docker Hub.
  ${CYN}--bump=X${R}          patch, minor, keep or 1.2.3 (skips the version prompt).
  ${CYN}--message=MSG${R}     Commit message (skips the prompt).
  ${CYN}-h, --help${R}        Show this help.

${DIM}Steps: [0] origin/main sync check, [1] version + changelog, [2] typecheck +
.github/workflows/ci.yml run locally by act, [3] docker build, [4] git commit/push/tag, [5] docker push + GitHub release.
When the version is bumped, [Unreleased] in CHANGELOG.md is renamed to the new
version and becomes the GitHub release notes. An empty [Unreleased] is left alone
and the release gets default notes. A failed or Ctrl+C'd run before [4] reverts
the bump and the changelog.${R}
EOF
}

SKIP_PUSH=false
SKIP_TESTS=false
SKIP_DOCKER_PUSH=false
BUMP_ARG=""
COMMIT_MSG=""
for arg in "$@"; do
    case "$arg" in
        --no-push) SKIP_PUSH=true ;;
        --no-test) SKIP_TESTS=true ;;
        --no-docker-push) SKIP_DOCKER_PUSH=true ;;
        --bump=*) BUMP_ARG="${arg#*=}" ;;
        --message=*) COMMIT_MSG="${arg#*=}" ;;
        -h|--help) usage; exit 0 ;;
        *) err "Unknown option: $arg"; echo "Run scripts/release.sh -h for the list." >&2; exit 1 ;;
    esac
done

docker info >/dev/null 2>&1 || die "Docker is not running."
# Checked before any prompt, so a missing act doesn't cost a version choice.
if [ "$SKIP_TESTS" = false ] && ! command -v act >/dev/null 2>&1; then
    die "act is not installed (winget install nektos.act). Or pass --no-test."
fi
if [ "$SKIP_PUSH" = false ]; then
    command -v gh >/dev/null 2>&1 || die "gh is not installed. Install the GitHub CLI or pass --no-push."
    gh auth status >/dev/null 2>&1 || die "gh is not logged in. Run gh auth login, or pass --no-push."
fi

cd "$SERVER_DIR"

printf '%s=== OwnGains Server Release ===%s\n' "$B$CYN" "$R"
printf '  Image         %s\n' "$DOCKER_IMAGE"
printf '  Tests         %s\n' "$(yn "$([ "$SKIP_TESTS" = true ] && echo false || echo true)")"
printf '  Commit+push   %s\n' "$(yn "$([ "$SKIP_PUSH" = true ] && echo false || echo true)")"
printf '  Docker push   %s\n' "$(yn "$([ "$SKIP_DOCKER_PUSH" = true ] && echo false || echo true)")"

# BACKUP_DIR is set from the version bump until the build succeeds. Any failure
# or Ctrl+C in that window restores package.json and CHANGELOG.md from it. They
# are copies, not git checkouts, because both usually hold uncommitted work.
BACKUP_DIR=""
cleanup() {
    local rc=$?
    set +e
    if [ -n "$BACKUP_DIR" ]; then
        if [ $rc -ne 0 ]; then
            err "Release did not finish, reverting version bump and changelog."
            cp "$BACKUP_DIR"/* "$SERVER_DIR/"
        fi
        rm -rf "$BACKUP_DIR"
    fi
}
trap cleanup EXIT
trap 'echo ""; err "Aborted."; exit 130' INT TERM

# [0/5] Sync check
if [ "$SKIP_PUSH" = true ]; then
    step 0/5 "Sync check: skipped (--no-push)"
else
    step 0/5 "Checking branch is up to date with origin/main"
    # Step 4 pushes main by name, so a release from another branch would tag a
    # commit that never reaches main.
    CURRENT_BRANCH=$(git branch --show-current)
    [ "$CURRENT_BRANCH" = main ] || die "On branch '${CURRENT_BRANCH:-detached HEAD}', not main."
    git fetch origin main
    git merge-base --is-ancestor origin/main HEAD \
        || die "origin/main has commits this checkout doesn't. Run 'git pull --rebase origin main' first."
    ok "Up to date"
fi

# [1/5] Version bump
step 1/5 "Version"

CURRENT_VERSION=$(bun -p "require('./package.json').version")
IFS='.' read -r CUR_MAJOR CUR_MINOR CUR_PATCH <<< "$CURRENT_VERSION"
AUTO_PATCH_VERSION="$CUR_MAJOR.$CUR_MINOR.$((CUR_PATCH + 1))"
AUTO_MINOR_VERSION="$CUR_MAJOR.$((CUR_MINOR + 1)).0"

KEEP_VERSION=false
case "$BUMP_ARG" in
    patch) VERSION_CHOICE=1 ;;
    minor) VERSION_CHOICE=2 ;;
    keep) VERSION_CHOICE=4 ;;
    "")
        echo "Current version: ${B}$CURRENT_VERSION${R}"
        echo "  [1] Patch  -> $AUTO_PATCH_VERSION ${DIM}(default)${R}"
        echo "  [2] Minor  -> $AUTO_MINOR_VERSION"
        echo "  [3] Custom"
        echo "  [4] Keep $CURRENT_VERSION"
        read -rp "${B}Choose 1-4:${R} " VERSION_CHOICE ;;
    *) VERSION_CHOICE=3; NEW_VERSION="$BUMP_ARG" ;;
esac

case "${VERSION_CHOICE:-1}" in
    2) NEW_VERSION="$AUTO_MINOR_VERSION" ;;
    3) [ -n "$BUMP_ARG" ] || read -rp "${B}Custom version (e.g. 2.0.0):${R} " NEW_VERSION ;;
    4) NEW_VERSION="$CURRENT_VERSION"; KEEP_VERSION=true ;;
    *) NEW_VERSION="$AUTO_PATCH_VERSION" ;;
esac

# Docker tags and git tags both assume a plain x.y.z.
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    die "'$NEW_VERSION' is not a valid x.y.z version."
fi

# Checked on the remotes, before the build, so a reused version stops the run
# before anything is written or pushed. Keeping the version re-releases on purpose.
if [ "$KEEP_VERSION" = false ]; then
    if git ls-remote --exit-code --tags origin "refs/tags/v$NEW_VERSION" >/dev/null 2>&1; then
        die "Tag v$NEW_VERSION already exists on origin. Choose another version."
    fi
    if [ "$SKIP_DOCKER_PUSH" = false ] && docker manifest inspect "$DOCKER_IMAGE:$NEW_VERSION" >/dev/null 2>&1; then
        die "$DOCKER_IMAGE:$NEW_VERSION already exists on Docker Hub. Choose another version."
    fi
fi

# Checked before anything is written, so a broken changelog stops the run clean.
# Keeping the version re-releases what's already stamped, so it skips this.
STAMP_CHANGELOG=false
if [ "$KEEP_VERSION" = false ]; then
    if bun scripts/changelog.mjs check "$NEW_VERSION"; then CHANGELOG_STATUS=0; else CHANGELOG_STATUS=$?; fi
    case "$CHANGELOG_STATUS" in
        0) STAMP_CHANGELOG=true; info "CHANGELOG.md: [Unreleased] will be stamped as [$NEW_VERSION]" ;;
        2) warn "CHANGELOG.md: [Unreleased] is empty, leaving it untouched. The release gets default notes." ;;
        *) die "CHANGELOG.md can't be stamped (see above). Fix it and re-run." ;;
    esac
fi

# Step 4 runs 'git add .', so everything listed here goes into the release commit.
if [ "$SKIP_PUSH" = false ]; then
    info "The release commit will include these changes, plus the version bump:"
    git status --short
fi

# Asked up front so the rest of the run is unattended.
if [ "$KEEP_VERSION" = false ] && [ "$SKIP_PUSH" = false ]; then
    [ -n "$COMMIT_MSG" ] || read -rp "${B}Commit message${R} (Enter for 'Release v$NEW_VERSION'): " COMMIT_MSG
    COMMIT_MSG="${COMMIT_MSG:-Release v$NEW_VERSION}"
fi

BACKUP_DIR="$(mktemp -d)"
cp package.json CHANGELOG.md "$BACKUP_DIR/"

NEW_VERSION="$NEW_VERSION" bun -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
pkg.version = process.env.NEW_VERSION;
fs.writeFileSync("./package.json", JSON.stringify(pkg, null, 2) + "\n");
'

# Stamped before the build, so the release commit carries this version's notes
# and a failed build reverts them along with the bump.
if [ "$STAMP_CHANGELOG" = true ]; then
    bun scripts/changelog.mjs stamp "$NEW_VERSION" "$(date +%Y-%m-%d)"
fi
ok "Version $CURRENT_VERSION -> ${B}$NEW_VERSION${R}"

# [2/5] Verify
if [ "$SKIP_TESTS" = true ]; then
    step 2/5 "Verifying: typecheck (CI run skipped by --no-test)"
else
    step 2/5 "Verifying: typecheck + CI under act"
fi
bunx tsc --noEmit
ok "typecheck"
# The GitHub workflow itself (fresh install, build, vitest on MariaDB 11.4 in
# Linux), so a push doesn't turn up a CI failure that a local run missed.
# act copies the working tree, uncommitted changes included, minus .gitignore.
if [ "$SKIP_TESTS" = false ]; then
    act push -j test --rm --pull=false -P ubuntu-latest=catthehacker/ubuntu:act-latest
    ok "CI (act)"
fi

# [3/5] Build Docker image
step 3/5 "Building Docker image v$NEW_VERSION"
# --pull because the base image is a floating tag, so a cached copy could lack
# Alpine security fixes.
docker build --pull -t "$DOCKER_IMAGE:latest" -t "$DOCKER_IMAGE:$NEW_VERSION" .
ok "Built $DOCKER_IMAGE:latest and :$NEW_VERSION"

# Past this point a commit or push may exist, so nothing is reverted any more.
rm -rf "$BACKUP_DIR"
BACKUP_DIR=""

# [4/5] Push source to GitHub
# Runs only after a successful build, so a bumped-but-broken version never
# becomes a pushed commit.
if [ "$SKIP_PUSH" = true ]; then
    step 4/5 "Git: skipped (--no-push)"
else
    step 4/5 "Git commit, push and tag"
    git add .

    if git diff --cached --quiet; then
        info "Nothing to commit, skipping push"
    elif [ "$KEEP_VERSION" = true ]; then
        warn "Version unchanged, committing on top (no amend, so pushed history is never rewritten)"
        git commit -m "Re-release v$NEW_VERSION"
        git push origin main
    else
        git commit -m "$COMMIT_MSG"
        git push origin main
    fi

    TAG="v$NEW_VERSION"
    CREATE_GH_RELEASE=false
    if git rev-parse "$TAG" >/dev/null 2>&1; then
        warn "Tag $TAG already exists locally, skipping tag creation"
    else
        git tag -a "$TAG" -m "Release $TAG"
        git push origin "$TAG"
        ok "Tagged and pushed $TAG"
        CREATE_GH_RELEASE=true
    fi
fi

# [5/5] Push to Docker Hub
if [ "$SKIP_DOCKER_PUSH" = true ]; then
    step 5/5 "Docker push: skipped (--no-docker-push)"
else
    step 5/5 "Pushing image to Docker Hub"
    # Version first, so a failed second push never leaves :latest on an
    # image that has no version tag.
    docker push "$DOCKER_IMAGE:$NEW_VERSION"
    docker push "$DOCKER_IMAGE:latest"
fi

# Created after the image push, so a release is never announced for an image
# nobody can pull. This version's CHANGELOG.md section becomes the release notes.
# gh was checked before the build, since CREATE_GH_RELEASE implies a push.
if [ "${CREATE_GH_RELEASE:-false}" = true ]; then
    NOTES_FILE="$(mktemp)"
    if ! bun scripts/changelog.mjs notes "$NEW_VERSION" "$NOTES_FILE" 2>/dev/null; then
        info "No [$NEW_VERSION] notes in CHANGELOG.md, using the default release text"
        echo "Release $TAG built on $(date '+%Y-%m-%d %H:%M')" > "$NOTES_FILE"
    fi
    GH_ARGS=("$TAG" --verify-tag --title "$TAG" --notes-file "$NOTES_FILE")
    if ! gh release create "${GH_ARGS[@]}"; then
        # The notes file is kept so the printed command still works.
        err "GitHub release failed. The tag and image are pushed, so retry only the release with:"
        printf '  gh release create' >&2; printf ' %q' "${GH_ARGS[@]}" >&2; printf '\n' >&2
        exit 1
    fi
    rm -f "$NOTES_FILE"
    ok "GitHub release $TAG"
fi

if [ "$SKIP_DOCKER_PUSH" = true ]; then
    printf '\n%s=== Done! Image built locally as :latest and :%s ===%s\n' "$B$GRN" "$NEW_VERSION" "$R"
else
    printf '\n%s=== Done! v%s pushed as :latest and :%s ===%s\n' "$B$GRN" "$NEW_VERSION" "$NEW_VERSION" "$R"
fi
printf '  Took %dm%02ds\n' $((SECONDS / 60)) $((SECONDS % 60))

# Without this bash reads on past the group and mis-seeks in the file.
exit 0
}

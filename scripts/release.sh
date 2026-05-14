#!/usr/bin/env bash
set -eo pipefail

BRANCH=$(git rev-parse --abbrev-ref HEAD | sed 's|^heads/||')
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on 'main' branch to release (currently on '$BRANCH')"
  exit 1
fi

if [[ -n $(git status --porcelain) ]]; then
  echo "Error: working tree is not clean — commit or stash changes first"
  exit 1
fi

git fetch origin main --quiet
if [[ $(git rev-parse HEAD) != $(git rev-parse origin/main) ]]; then
  echo "Error: local main is not in sync with origin — run git pull first"
  exit 1
fi

CURRENT=$(node -p "require('./package.json').version")

echo ""
echo "Current version: v$CURRENT"
echo ""
echo "Select release type:"
echo "  1) patch  (bug fix)"
echo "  2) minor  (new feature)"
echo "  3) major  (breaking change)"
echo "  4) current version (tag v$CURRENT without bumping)"
echo ""
read -rp "Choice [1/2/3/4]: " choice

case $choice in
  1) TYPE=patch ;;
  2) TYPE=minor ;;
  3) TYPE=major ;;
  4) TYPE=current ;;
  *) echo "Invalid choice"; exit 1 ;;
esac

if [[ "$TYPE" == "current" ]]; then
  NEXT="$CURRENT"
else
  NEXT=$(npm version "$TYPE" --no-git-tag-version --dry-run 2>/dev/null | tr -d 'v')
  if [[ -z "$NEXT" ]]; then
    echo "Error: failed to compute next version"
    exit 1
  fi
fi

echo ""
if [[ "$TYPE" == "current" ]]; then
  echo "  Tag current version: v$CURRENT (no version bump)"
else
  echo "  v$CURRENT  →  v$NEXT  ($TYPE)"
fi
echo ""
read -rp "Confirm release? [y/N]: " confirm

if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

if [[ "$TYPE" == "current" ]]; then
  if git tag -l "v$NEXT" | grep -q "v$NEXT"; then
    echo ""
    echo "Tag v$NEXT already exists locally."
    read -rp "Force retag? This will delete and recreate the tag [y/N]: " retag
    if [[ "$retag" != "y" && "$retag" != "Y" ]]; then
      echo "Aborted."
      exit 0
    fi
    git tag -d "v$NEXT"
    git push origin ":refs/tags/v$NEXT" 2>/dev/null || true
  fi

  git tag "v$NEXT"

  if ! git push origin "v$NEXT"; then
    echo ""
    echo "Error: git push tag failed"
    git tag -d "v$NEXT" 2>/dev/null || true
    exit 1
  fi
else
  npm version "$TYPE" --no-git-tag-version

  git add package.json package-lock.json
  git commit -m "v$NEXT"

  if ! git push; then
    echo ""
    echo "Error: git push failed — reverting version bump"
    git reset --hard HEAD~1
    exit 1
  fi

  git tag "v$NEXT"

  if ! git push origin "v$NEXT"; then
    echo ""
    echo "Error: git push tag failed"
    echo "The version commit was already pushed. Push the tag manually:"
    echo "  git push origin v$NEXT"
    exit 1
  fi
fi

echo ""
echo "Released v$NEXT — GitHub Actions will publish to npm automatically."

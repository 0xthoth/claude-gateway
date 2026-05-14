#!/usr/bin/env bash
set -e

BRANCH=$(git rev-parse --abbrev-ref HEAD | sed 's|^heads/||')
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on 'main' branch to release (currently on '$BRANCH')"
  exit 1
fi

if [[ -n $(git status --porcelain) ]]; then
  # Check if ONLY package.json / package-lock.json are dirty (partial npm version run)
  DIRTY_OTHER=$(git status --porcelain | grep -v 'package\.json$' | grep -v 'package-lock\.json$')
  if [[ -n "$DIRTY_OTHER" ]]; then
    echo "Error: working tree is not clean — commit or stash changes first"
    exit 1
  fi

  PARTIAL_VERSION=$(node -p "require('./package.json').version")
  echo ""
  echo "Detected partial release: package.json is already at v$PARTIAL_VERSION but not committed."
  echo ""
  echo "  1) Complete the release — commit + tag v$PARTIAL_VERSION and push"
  echo "  2) Reset and start over"
  echo "  3) Abort"
  echo ""
  read -rp "Choice [1/2/3]: " recovery

  case $recovery in
    1)
      git add package.json package-lock.json
      git commit -m "v$PARTIAL_VERSION"
      if ! git push; then
        echo "Error: git push failed"
        git reset --soft HEAD~1
        exit 1
      fi
      git tag "v$PARTIAL_VERSION"
      if ! git push origin "v$PARTIAL_VERSION"; then
        echo "Error: git push tag failed. Push manually: git push origin v$PARTIAL_VERSION"
        exit 1
      fi
      echo ""
      echo "Released v$PARTIAL_VERSION — GitHub Actions will publish to npm automatically."
      exit 0
      ;;
    2)
      git checkout -- package.json package-lock.json
      echo "Reset. Continuing with fresh release..."
      echo ""
      ;;
    *)
      echo "Aborted."
      exit 0
      ;;
  esac
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
  npm version "$TYPE"

  if ! git push; then
    echo ""
    echo "Error: git push failed — reverting version bump"
    git tag -d "v$NEXT" 2>/dev/null || true
    git reset --hard HEAD~1
    exit 1
  fi

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

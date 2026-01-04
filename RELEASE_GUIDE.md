# Release Guide for Chess Analysis Plugin

This guide will help you publish your Chess Analysis plugin to the Obsidian Community Plugins directory.

## Prerequisites Checklist

✅ All required files are present:
- `main.js` (145KB) - Compiled plugin
- `manifest.json` - Plugin metadata
- `styles.css` - Plugin styles
- `versions.json` - Version compatibility tracker
- `LICENSE` - MIT License
- `README.md` - Documentation with screenshots

✅ Git repository is set up and connected to GitHub:
- Repository: https://github.com/bbwfan85/chess-plugin.git

## Step 1: Commit Your Changes

First, commit the new files and changes:

```bash
git add versions.json package.json
git commit -m "Prepare v1.0.0 release

- Add versions.json for Obsidian compatibility tracking
- Update package.json author field
- Include comprehensive README with screenshots"
```

## Step 2: Push to GitHub

```bash
git push origin main
```

## Step 3: Create a GitHub Release

### Option A: Using GitHub Web Interface (Recommended)

1. Go to your repository: https://github.com/bbwfan85/chess-plugin
2. Click on "Releases" in the right sidebar
3. Click "Create a new release"
4. Fill in the release details:
   - **Tag version**: `1.0.0` (must match version in manifest.json)
   - **Release title**: `1.0.0` or `Chess Analysis v1.0.0`
   - **Description**: Write release notes (see example below)
5. **Upload the following files as release assets**:
   - `main.js`
   - `manifest.json`
   - `styles.css`
6. Click "Publish release"

### Option B: Using GitHub CLI (gh)

If you have GitHub CLI installed:

```bash
# Create the release
gh release create 1.0.0 \
  --title "Chess Analysis v1.0.0" \
  --notes "Initial release of Chess Analysis plugin for Obsidian

Features:
- Interactive chess board with PGN and FEN notation support
- Move-by-move navigation and playback
- Chess engine analysis with evaluation scores
- Annotation tools (arrows, highlights, notes)
- Drag-and-drop piece movement
- Mobile and desktop support
- Resizable panels and customizable layout"

# Upload release assets
gh release upload 1.0.0 main.js manifest.json styles.css
```

### Example Release Notes

```markdown
# Chess Analysis v1.0.0

Initial release of the Chess Analysis plugin for Obsidian!

## Features

✨ **PGN & FEN Support**
- Analyze complete chess games using PGN notation
- Display any position using FEN notation
- Full game metadata and annotations

🎮 **Interactive Board**
- Move-by-move navigation
- Click-to-move between positions
- Board flip for different perspectives
- Resizable panels

🤖 **Engine Analysis**
- Stockfish integration for position evaluation
- Best move suggestions
- Configurable analysis depth

✏️ **Annotation Tools**
- Draw arrows on the board
- Highlight important squares
- Add notes to specific moves
- Persistent annotations saved in your vault

📱 **Cross-Platform**
- Works on desktop (Windows, macOS, Linux)
- Mobile support (iOS, Android)
- Touch-friendly controls

## Installation

Install from Obsidian's Community Plugins browser by searching for "Chess Analysis"

## Requirements

- Obsidian v0.15.0 or higher

## Links

- [GitHub Repository](https://github.com/bbwfan85/chess-plugin)
- [Report Issues](https://github.com/bbwfan85/chess-plugin/issues)
```

## Step 4: Verify Your Release

After creating the release:

1. Go to https://github.com/bbwfan85/chess-plugin/releases
2. Verify that version `1.0.0` appears
3. Check that all three files are attached:
   - ✅ main.js
   - ✅ manifest.json
   - ✅ styles.css

## Step 5: Submit to Obsidian Community Plugins

Once your GitHub release is live:

1. Fork the official repository: https://github.com/obsidianmd/obsidian-releases
2. Add your plugin to `community-plugins.json`:

```json
{
  "id": "chess-analysis",
  "name": "Chess Analysis",
  "author": "bbwfan85",
  "description": "Analyze chess games from PGN or FEN notation with an interactive board, move navigation, and annotations. Take notes on every move as well as see recommended engine moves and position evaluation bar.",
  "repo": "bbwfan85/chess-plugin"
}
```

3. Submit a Pull Request with the title: "Add Chess Analysis plugin"
4. In the PR description, include:
   - Link to your repository
   - Brief description of what your plugin does
   - Confirmation that you've tested it with the specified minimum Obsidian version

## Step 6: Wait for Review

The Obsidian team will review your submission:
- They'll check that your plugin follows guidelines
- Verify all required files are present in the release
- Test basic functionality
- May request changes if needed

Once approved and merged, your plugin will appear in the Community Plugins browser within Obsidian!

## Future Releases

When you want to release a new version:

1. Update version number in:
   - `manifest.json`
   - `package.json`
2. Add new version to `versions.json`:
   ```json
   {
     "1.0.0": "0.15.0",
     "1.0.1": "0.15.0"
   }
   ```
3. Build the plugin: `node build-simple.mjs`
4. Commit changes
5. Create new GitHub release with updated files
6. The plugin will auto-update for users

## Important Notes

⚠️ **Do NOT include in releases:**
- `node_modules/` (excluded by .gitignore)
- Source TypeScript files (users only need compiled JS)
- Development files

✅ **Always include in releases:**
- `main.js` - The compiled plugin
- `manifest.json` - Plugin metadata
- `styles.css` - Required for your plugin's styling

## Troubleshooting

### Release assets not showing
- Make sure files are uploaded to the GitHub release (not just committed to repo)
- Files must be attached directly to the release

### Plugin not appearing in Obsidian
- Check that your PR to obsidian-releases was merged
- Verify the `repo` field matches your GitHub username/repo-name
- Ensure release tag matches version in manifest.json

### Users reporting issues
- Direct them to: https://github.com/bbwfan85/chess-plugin/issues
- Ask for Obsidian version and example PGN/FEN that causes problems
- Check compatibility with minimum Obsidian version

## Resources

- [Obsidian Plugin Guidelines](https://docs.obsidian.md/Plugins/Publishing/Plugin+guidelines)
- [Obsidian Developer Docs](https://docs.obsidian.md/)
- [Community Plugin Submission](https://github.com/obsidianmd/obsidian-releases)

---

Good luck with your release! 🎉

# Planner timer

The [Planner](https://github.com/Gizmo73/to-do-list) focus timer in a browser:
the same hourglass as the phone app, kept in sync through a small file in the
app's hidden Google Drive folder.

Open it at <https://gizmo73.github.io/planner-timer/> and sign in with the same
Google account as the app.

This repo holds only the static page (HTML, CSS, JS). It has no secrets: the
Google client ID in `config.js` is public by design and only accepted from this
site's address. Each person who signs in can only reach their own Drive and
Tasks.

In Obsidian, use the plugin in [`obsidian/`](obsidian/README.md): Google won't
finish signing in inside Obsidian's Web Viewer, so the plugin signs in through
your normal browser and shows this page in a tab.

Every push to `main` publishes the page with GitHub Pages.

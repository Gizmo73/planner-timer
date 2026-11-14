# Planner timer for Obsidian

The Planner focus timer in an Obsidian tab. Google won't finish signing in inside
Obsidian (its Web Viewer gets a "401. That's an error."), so this plugin signs in
through your normal browser, keeps that sign-in, and shows the timer page in a tab.
The hourglass is the same page as <https://gizmo73.github.io/planner-timer/>, so it
changes whenever the page does.

Desktop only. Your Google sign-in is kept in Obsidian's own storage on that computer,
not in the vault, so it doesn't travel with vault sync; sign in once per computer.

## 1. Create a Desktop client (once)

1. Open <https://console.cloud.google.com/auth/clients> with the **same project as the
   phone app** selected. (Another project can't see the phone's timer file.)
2. **Create client** → Application type **Desktop app** → Name `Planner Obsidian` →
   **Create**.
3. Copy the **Client ID** and the **Client secret** straight away; Google may not show
   the secret again. A Desktop client's secret isn't truly secret (Google says so
   itself): on its own it can't reach anyone's data.

No redirect URIs are needed. Desktop clients are always allowed to come back to
`http://127.0.0.1`.

## 2. Install the plugin

1. In your vault, make the folder `.obsidian/plugins/planner-timer/`.
2. Download these three files into it:
   - <https://gizmo73.github.io/planner-timer/obsidian/main.js>
   - <https://gizmo73.github.io/planner-timer/obsidian/manifest.json>
   - <https://gizmo73.github.io/planner-timer/obsidian/styles.css>
3. In Obsidian: **Settings → Community plugins**, turn on community plugins if asked,
   then switch on **Planner timer** (you may need to press the reload button first).

To update later, download the three files again and reload the plugin.

## 3. Sign in

1. **Settings → Planner timer**: paste the Client ID and Client secret.
2. Open the timer from the hourglass in the left ribbon (or the command palette:
   **Planner timer: Open timer**) and press **Sign in with Google**.
3. Your normal browser opens. Sign in with the same Google account as the phone app
   and allow access (if you see "Google hasn't verified this app": **Advanced → Go to
   Planner**). When it says you're signed in, go back to Obsidian.

That's it: the plugin hands the timer a fresh token before each one runs out, so it
stays signed in. **Settings → Planner timer → Sign out** forgets the sign-in on that
computer.

## Why the client ID and secret aren't built in

They're saved in the vault's plugin settings (`data.json`) so you only paste them
once. This repo is public, and keeping them out of it keeps the client yours alone.

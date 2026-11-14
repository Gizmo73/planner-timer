// Planner timer for Obsidian.
//
// Google won't finish signing in inside Obsidian, so this plugin signs in through your
// normal browser instead, keeps that sign-in, and shows the timer page in a tab, handing
// it a fresh access token whenever it needs one. The timer itself is the same page as
// in a browser, so it updates whenever the page does.
"use strict";

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, requestUrl } = require("obsidian");
const http = require("http");
const crypto = require("crypto");

const VIEW_TYPE = "planner-timer-view";
const PAGE_ORIGIN = "https://gizmo73.github.io";
const PAGE_URL = `${PAGE_ORIGIN}/planner-timer/?host=obsidian`;
const SCOPES = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/tasks";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SIGNIN_TIMEOUT_MS = 5 * 60 * 1000;
const RENEW_EARLY_MS = 5 * 60 * 1000;
// Kept in Obsidian's own storage on this computer, not in the vault, so it never syncs.
const REFRESH_KEY = "planner-timer-refresh-token";

const DEFAULTS = { clientId: "", clientSecret: "" };

const base64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

class SetupNeeded extends Error {}
class SignInNeeded extends Error {}

module.exports = class PlannerTimerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.access = null;      // { token, exp }
    this.refreshing = null;  // a token request already under way
    this.signingIn = null;   // a browser sign-in already under way

    this.registerView(VIEW_TYPE, (leaf) => new TimerView(leaf, this));
    this.addRibbonIcon("hourglass", "Open Planner timer", () => this.openView());
    this.addCommand({ id: "open", name: "Open timer", callback: () => this.openView() });
    this.addSettingTab(new TimerSettings(this.app, this));
  }

  onunload() {
    this.cancelSignIn?.();
  }

  async openView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing || this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---------- Stored sign-in ----------

  get refreshToken() {
    if (typeof this.app.loadLocalStorage === "function") return this.app.loadLocalStorage(REFRESH_KEY) || null;
    return window.localStorage.getItem(`${this.app.vault.getName()}-${REFRESH_KEY}`);
  }

  set refreshToken(value) {
    if (typeof this.app.saveLocalStorage === "function") return this.app.saveLocalStorage(REFRESH_KEY, value || null);
    const key = `${this.app.vault.getName()}-${REFRESH_KEY}`;
    value ? window.localStorage.setItem(key, value) : window.localStorage.removeItem(key);
  }

  get signedIn() {
    return !!this.refreshToken;
  }

  checkSetup() {
    if (!this.settings.clientId.trim() || !this.settings.clientSecret.trim()) {
      throw new SetupNeeded("Add the Desktop client ID and secret in Settings → Planner timer first.");
    }
  }

  async postToken(params) {
    const res = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        client_id: this.settings.clientId.trim(),
        client_secret: this.settings.clientSecret.trim(),
        ...params,
      }).toString(),
      throw: false,
    });
    let json = {};
    try { json = res.json; } catch {}
    return { status: res.status, json };
  }

  // A valid access token, renewing it with the stored sign-in when it's close to running out.
  async accessToken() {
    if (this.access && this.access.exp - RENEW_EARLY_MS > Date.now()) return this.access;
    if (!this.refreshing) {
      this.refreshing = this.renew().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async renew() {
    this.checkSetup();
    const refresh = this.refreshToken;
    if (!refresh) throw new SignInNeeded();
    const { status, json } = await this.postToken({ grant_type: "refresh_token", refresh_token: refresh });
    if (json.access_token) return this.keepAccess(json);
    if (json.error === "invalid_grant") {
      // Revoked, or the password changed: sign in again.
      this.refreshToken = null;
      throw new SignInNeeded();
    }
    throw new Error(`Google said no (${json.error_description || json.error || status}).`);
  }

  keepAccess(json) {
    this.access = { token: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
    return this.access;
  }

  // ---------- Signing in through the normal browser ----------

  signIn() {
    if (!this.signingIn) {
      this.signingIn = this.browserSignIn().finally(() => { this.signingIn = null; });
    }
    return this.signingIn;
  }

  async browserSignIn() {
    this.checkSetup();
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));

    // Google sends the browser back to a tiny server on this computer with a one-time code.
    const { code, redirectUri } = await new Promise((resolve, reject) => {
      let redirectUri = "";
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, redirectUri);
        if (url.pathname !== "/") { res.writeHead(404).end(); return; }
        const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end(page(ok
          ? "You're signed in. You can close this tab and go back to Obsidian."
          : "Signing in didn't finish. Go back to Obsidian and try again."));
        finish(ok ? null : new Error(url.searchParams.get("error") || "Signing in didn't finish."), url.searchParams.get("code"));
      });
      const timer = setTimeout(() => finish(new Error("Signing in timed out.")), SIGNIN_TIMEOUT_MS);
      let done = false;
      const finish = (err, code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        server.close();
        server.closeIdleConnections?.();
        this.cancelSignIn = null;
        err ? reject(err) : resolve({ code, redirectUri });
      };
      this.cancelSignIn = () => finish(new Error("Cancelled."));
      server.on("error", (e) => finish(e));
      server.listen(0, "127.0.0.1", () => {
        redirectUri = `http://127.0.0.1:${server.address().port}`;
        const url = `${AUTH_URL}?${new URLSearchParams({
          client_id: this.settings.clientId.trim(),
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPES,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          access_type: "offline",
          prompt: "consent",
        })}`;
        openInBrowser(url);
      });
    });

    const { status, json } = await this.postToken({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    if (!json.access_token) throw new Error(`Google said no (${json.error_description || json.error || status}).`);
    if (json.refresh_token) this.refreshToken = json.refresh_token;
    return this.keepAccess(json);
  }

  // Forgets the sign-in on this computer only. It isn't revoked at Google, because that
  // could also cut off the phone's access to the same Drive folder.
  signOut() {
    this.refreshToken = null;
    this.access = null;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.reload?.();
  }
};

function openInBrowser(url) {
  try {
    require("electron").shell.openExternal(url);
  } catch {
    window.open(url);
  }
}

function page(message) {
  const esc = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return `<!doctype html><meta charset="utf-8"><title>Planner timer</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0">
<p style="font-size:1.2rem">${esc}</p></body>`;
}

// ---------- The tab ----------

class TimerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.renewTimer = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Planner timer"; }
  getIcon() { return "hourglass"; }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("planner-timer-view");
    this.frame = this.contentEl.createEl("iframe", { attr: { src: PAGE_URL, allow: "autoplay" } });
    this.onMessage = (e) => {
      if (e.source !== this.frame?.contentWindow || e.origin !== PAGE_ORIGIN) return;
      const type = e.data?.type;
      if (type === "planner-token-request") this.sendToken(false);
      else if (type === "planner-signin") this.sendToken(true);
    };
    window.addEventListener("message", this.onMessage);
  }

  async onClose() {
    window.removeEventListener("message", this.onMessage);
    clearTimeout(this.renewTimer);
  }

  reload() {
    clearTimeout(this.renewTimer);
    if (this.frame) this.frame.src = PAGE_URL;
  }

  post(message) {
    // Only ever to the timer page's own address.
    this.frame?.contentWindow?.postMessage(message, PAGE_ORIGIN);
  }

  async sendToken(interactive) {
    clearTimeout(this.renewTimer);
    try {
      const access = interactive ? await this.plugin.signIn() : await this.plugin.accessToken();
      this.post({ type: "planner-token", token: access.token });
      // Hand over the next one shortly before this one runs out, so syncing never stalls.
      const wait = Math.max(access.exp - RENEW_EARLY_MS - Date.now() + 1000, 30000);
      this.renewTimer = setTimeout(() => this.sendToken(false), wait);
    } catch (e) {
      if (e instanceof SignInNeeded) this.post({ type: "planner-need-signin" });
      else {
        this.post({ type: "planner-error", message: e.message });
        if (interactive) new Notice(`Planner timer: ${e.message}`);
      }
    }
  }
}

// ---------- Settings ----------

class TimerSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", {
      text: "Use a Desktop app client from the same Google Cloud project as the phone app. " +
        "The client ID and secret are saved with your vault's plugin settings; " +
        "your sign-in stays on this computer only.",
    });

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Ends in .apps.googleusercontent.com")
      .addText((t) => t.setValue(this.plugin.settings.clientId).onChange(async (v) => {
        this.plugin.settings.clientId = v.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Client secret")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.clientSecret).onChange(async (v) => {
          this.plugin.settings.clientSecret = v.trim();
          await this.plugin.saveSettings();
        });
      });

    const signedIn = this.plugin.signedIn;
    new Setting(containerEl)
      .setName("Google account")
      .setDesc(signedIn ? "Signed in on this computer." : "Not signed in. Open the timer and sign in from there.")
      .addButton((b) => signedIn
        ? b.setButtonText("Sign out").onClick(() => { this.plugin.signOut(); this.display(); })
        : b.setButtonText("Open timer").setCta().onClick(() => this.plugin.openView()));
  }
}

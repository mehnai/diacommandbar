# Dia Command Bar

A lightweight, Arc-inspired command bar for Dia and other Chromium browsers. It can show a separate command page for new tabs and opens as an overlay on websites with **⌘⇧L** on Mac or **Ctrl+Shift+L** on Windows/Linux. An optional setting also turns **⌘T / Ctrl+T** into an overlay over your previous website.

## Install in Dia

1. Open `chrome://extensions` in Dia (or use **Extensions → Manage Extensions**).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder, which contains `manifest.json`. You can also select the clean `dist/dia-command-bar` folder after running `npm run package`.
4. Pin **Dia Command Bar** in the extensions menu.
5. Press **⌘⇧L** on a website, or click the extension icon.
6. For **⌘T / Ctrl+T**, open **Settings → Overlay → Open new tabs as an overlay**, enable it, and allow website access. Return to a website and open a new tab to try it.

There is no build step and no account to set up. Keep the installed folder in place. After changing source files, click **Reload** on the extension card and refresh any open command bar pages.

### Dia and the new tab shortcut

Open **Settings → New tab → Use a separate command page** to choose whether fresh tabs show the extension's page or your browser's own homepage. It starts **On** to preserve the existing behavior. Choosing **Off** takes effect for the next new tab, leaves existing tabs alone, and keeps the toolbar icon and extension shortcut available.

**Settings → Overlay → Open new tabs as an overlay** is an independent choice. It starts **Off** and requests optional HTTP/HTTPS website access when enabled. The browser's reserved **⌘T / Ctrl+T** shortcut does not grant temporary access to the previous website.

| Separate command page | New-tab overlay | What a fresh tab does |
| --- | --- | --- |
| On | Off | Opens the separate command page. |
| Off | Off | Keeps Dia's own homepage (or Chromium's native new-tab page). |
| On | On | Opens an overlay over the previous website; falls back to the command page when an overlay is unavailable. |
| Off | On | Opens an overlay over the previous website; keeps the native homepage when an overlay is unavailable. |

The browser still creates a new tab first. When overlay mode is available, the extension waits for the bar to respond, switches back to the previous website in the same window, and closes only the temporary tab. A brief tab flash is possible. Existing pages, explicit destinations, and tabs where navigation has started are kept. Turning overlay mode off removes its broad website permission. Chromium may also remove a Google grant covered by that permission; if so, settings explains how to renew search suggestions.

The extension observes fresh native tabs instead of using an unconditional manifest new-tab override, so choosing the browser homepage works without disabling the extension or redirecting it in a loop. Dia's `chrome://start-page/<UUID>` homepage and Chromium's native new-tab addresses are recognized. A candidate must be less than ten seconds old, active, unpinned, and not discarded. Dia's initially inactive placeholders wait for both activation and a confirmed homepage address. Existing tabs, deeper chat paths, query strings, and tabs already navigating elsewhere are left alone. New windows follow the separate-page choice because they have no previous website. Dia's undocumented internal address can change between browser versions.

Use **⌘⇧L** or the toolbar icon for the Arc-style overlay. On internal browser pages, the Chrome Web Store, or pages that block embedding, it opens a separate command tab. Invoking it on an existing command page focuses that page's search field and preserves your query, without opening another tab or requesting host access. Customize the shortcut at `chrome://extensions/shortcuts`; some browser and system shortcuts cannot be reassigned. When a new tab opens, the browser may keep keyboard focus in its address bar. Click the command field or use the extension shortcut to focus it.

## Use it

| Input / key | Action |
| --- | --- |
| A phrase | Search with your browser's default search engine |
| `example.com` or `localhost:3000` | Navigate directly |
| `@` | Find and switch to an open tab, including tabs in other windows |
| `*` | Search bookmarks after granting access |
| `#` | Search history after granting access (7, 30, or 90 days) |
| `>` | Browser actions: downloads, history, bookmarks, extensions, new window, settings |
| `↑` / `↓` | Move through results |
| `Enter` | Open the selected result |
| `⌘Enter` / `Ctrl+Enter` | Open navigation or search results in a new tab |
| `⌘1…9` / `Ctrl+1…9` | Select a result when the command input has focus and the browser does not reserve the shortcut |
| `Esc` | Clear the search; press again to dismiss an overlay |
| `⌘,` / `Ctrl+,` | Open settings |

**Settings → Search → Open results in** applies to both the separate page and the overlay. **Automatic** (the default) preserves the website by using a new tab from overlays, and reuses the separate command page. **This tab** replaces the current website when used in an overlay. **A new tab** always creates a new tab. Holding Command/Control with Enter also forces a new tab. Selecting an existing tab switches to it regardless of this preference. New-tab overlay mode closes only the empty tab it just received; your existing tabs stay open.

The overlay background is transparent, with no page dimming or blur. Its embedded page is clipped to the visible controls so an opaque browser canvas cannot hide the surrounding website. Drag the small grip at the top to move the bar; double-click it to center the bar again. You can also focus the grip with Shift+Tab from the search field, move it with the arrow keys (Shift for larger steps), and press Home to center it. The bar stays within the window when results grow or the window resizes, and starts centered unless **Settings → Overlay → Remember where I moved it** is on. Remembered positions last for the browser session; double-click or Home clears the saved position. Outside-click dismissal can also be turned off. Dragging uses native pointer events with no added dependencies or permissions.

## Customize

Open **Settings** in the bar footer, press **⌘, / Ctrl+,**, or type **> settings**. Settings use text choices and small steppers, with seven sections:

- **Appearance:** system/light/dark, monochrome or blue/green/orange/red accents, UI/serif/mono font, spacing, roundness, width, and higher contrast.
- **Command bar:** inverted or soft selection, filters, icons, result labels, number labels, and keyboard hints. Hiding hints keeps the settings shortcut and action available.
- **New tab:** separate command page on/off, live date/time, 12/24-hour format, position, and plain or dot-grid background. These appearance settings affect the separate page; overlays remain transparent and have no clock.
- **Search:** default/Google/DuckDuckGo/Bing/Brave/custom engine, optional Google suggestions, 3–10 results in total (including the direct action and suggestions), and where destinations open. Custom addresses must use HTTPS, contain `%s` for the encoded query, and have no credentials.
- **Sources:** default scope, current/all windows, optional bookmarks/history, and a 7/30/90-day history range. Clear/Escape resets to the default scope.
- **Overlay:** new-tab handoff, outside-click dismissal, and remembered position.
- **Shortcuts:** actual browser binding, palette keys, and a link to browser shortcut settings.

Font changes apply to the input, results, settings, footer, and shortcut labels. **Dia** uses ABC Oracle when installed, then the system UI font; **Serif** and **Mono** use installed serif and monospace fonts. The clock deliberately keeps its display font. No font files are bundled or downloaded.

Preferences stay in this browser profile. The old lilac/sage/rose/sand accents migrate to monochrome; existing search, theme, and overlay preferences are retained. The older “This tab” value migrates to **Automatic**, preserving its previous behavior; select **This tab** again to explicitly replace the website beneath an overlay. **Restore defaults** resets customization, turns the separate command page back on, turns off autocomplete and new-tab overlays, clears remembered position, and revokes all optional bookmark, history, Google, and HTTP/HTTPS site grants (including individual-site grants). It cancels pending suggestions and verifies that the grants were removed. If the browser refuses, it reports the failure rather than claiming success. Features require enabling and granting access again. Existing HTTP custom search templates are rejected; replace them with an HTTPS template in Settings → Search.

### Arc-style preset: exact settings to select

Use the following selections for the closest supported Arc-style workflow: **⌘T** opens a command bar over the current website, and submitting a new destination opens a tab. Arc documents its [Command-T command bar](https://start.arc.net/master-multitasking) and [command actions](https://start.arc.net/command-bar-actions). The visual choices below are an approximation using this extension's controls; Arc's themes, native fonts, Spaces, and ranking are not reproduced exactly.

| Section | Setting | Select |
| --- | --- | --- |
| New tab | Use a separate command page | **Off** |
| Overlay | Open new tabs as an overlay | **On** — allow website access |
| Overlay | Close when I click outside | **On** |
| Overlay | Remember where I moved it | **Off** |
| Appearance | Theme | **Match system** |
| Appearance | Accent color | **Blue** |
| Appearance | Font | **Dia** |
| Appearance | Spacing | **Comfortable** |
| Appearance | Roundness | **14px** |
| Appearance | Bar width | **620px** |
| Appearance | Contrast | **Normal** |
| Command bar | Highlight | **Soft** |
| Command bar | Show filter buttons | **Off** |
| Command bar | Show icons | **On** |
| Command bar | Label each result | **On** |
| Command bar | Show number shortcuts | **Off** |
| Command bar | Show keyboard hints | **Off** |
| Search | Search with | **Browser default** — set Dia's default to the engine you used in Arc |
| Search | Suggest searches as I type | **On** — allow Google access |
| Search | How many results | **6 results** |
| Search | Open results in | **A new tab** |
| Sources | Start by searching | **Everything** |
| Sources | Include tabs from other windows | **Off** |
| Sources | Search my bookmarks | **On** — allow bookmark access |
| Sources | Search my history | **On** — allow history access |
| Sources | Look back | **3 months** |
| New tab | Show date and time | **Off** |
| New tab | Time format | **3:30 PM** (unused while the clock is off) |
| New tab | Bar position | **Middle** (separate page only) |
| New tab | Background | **Plain** (separate page only) |

Keep **⌘⇧L** as the extension's secondary shortcut. Do not try to assign **⌘T** in the browser shortcut editor: overlay mode handles fresh tabs created by that reserved shortcut. With keyboard hints hidden, open settings using **⌘,** or type **> settings**. New windows and restricted pages retain Dia's homepage; explicitly invoking the extension there can still open its command page because browser-internal pages cannot host the overlay.

This preset asks for optional access so local bookmark/history matches and automatic overlays work. Enabling suggestions sends eligible partial searches to Google, regardless of the search engine you select. Leave suggestions **Off** if you prefer to keep unfinished queries local. Apply the choices manually; the preset does not change your settings just by being documented.

### Optional query autocomplete

Open **Settings → Search → Suggest searches as I type** and choose **On**. It is **off by default** and asks for permission to contact `suggestqueries.google.com` when enabled. After a 250 ms typing pause, it sends the entered search text to Google and displays up to five query suggestions. Clicking a suggestion or pressing Enter searches with your selected search engine; Google is the suggestion provider.

Requests require at least three characters. Address-like input, `@`/`*`/`#`/`>` source searches, and private browsing do not request completions. No requests are made while settings are open or the command page is hidden. New input cancels the previous request, and late responses cannot replace newer results. Connection errors and timeouts leave local results and the normal search action available.

Choosing **Off** cancels pending requests and revokes the optional Google host permission unless new-tab overlay mode still needs website access, which also covers Google's host. Autocomplete remains off regardless of that permission. Queries and suggestions are not saved by the extension; requests omit cookies and referrers. Google receives the text you type when this option is enabled, including partial searches. This uses Google's browser autocomplete endpoint rather than a versioned public API; it may be unavailable or change independently of the extension.

To update an installed copy, click **Reload** on the extension card at `chrome://extensions`, then reopen the command bar. If you enabled autocomplete in version 1.1.0, enable it again to grant access to Google; the old DuckDuckGo permission does not grant access to the new provider. The packaged folder is updated in place by `npm run package`.

## Privacy and permissions

There are no runtime dependencies, remote scripts, remote fonts, or analytics. A restrictive Content Security Policy allows network connections only to Google's HTTPS autocomplete endpoint and loads scripts, styles, and images only from the extension. Other resource loads and form submissions are blocked. This policy covers extension pages and the worker; normal navigation and submitted searches still open through browser APIs. Tab, bookmark, and history matches stay local. Results use text and local icons; the extension does not send your browsing data to a favicon service. Query autocomplete makes requests to Google only after you enable it and grant its host permission. Submitted searches go to your selected search engine.

- `tabs`: read titles and URLs to search and switch tabs.
- `activeTab` and `scripting`: insert the overlay after you click the extension or invoke its shortcut. This works without persistent access to all websites.
- `storage`: save settings, temporary overlay authorization tokens, and tab IDs for new-tab handoffs locally. Handoff state and optional remembered overlay position are session-only.
- `search`: use the browser's default search provider.
- Optional `bookmarks` and `history`: enabled only through an explicit permission request. Turning either setting off revokes that permission.
- Optional `https://suggestqueries.google.com/*` host access: requested for query autocomplete. The browser's permission prompt covers the host, even though the extension only fetches its autocomplete endpoint.
- Optional `http://*/*` and `https://*/*` host access: requested only when you enable **Open new tabs as an overlay**, to draw over the previous website without an extension-button gesture. It does not enable autocomplete or send page contents anywhere. Disabling this option removes the broad grants and can require renewing Google autocomplete access.

The embedded command page verifies its extension origin and a per-tab token before accepting privileged operations. Window messages carry only control bounds and UI dismissal; external websites cannot issue browser commands through them. Website text is rendered as text, never HTML. Executable URLs and URLs containing credentials are rejected.

## Develop and verify

Node.js 20+ is needed for development only.

```sh
npm install
npx playwright install chromium
npm test
npm run test:browser
npm run preview
npm run package
```

The preview is at `http://127.0.0.1:4173`. It uses sample tabs and does not perform real browser actions; its browser title identifies it as a design preview. The installed extension uses real data and never shows the sample tabs.

Browser tests load the real extension into an isolated Chromium profile and cover the optional native/command new-tab routing and overlay handoff, tab switching, navigation, settings, overlay lifecycle, restricted-page fallback, authorization boundaries, and autocomplete/website permission interactions. Optional hosts are pre-granted through Chromium's extension-management API because the headless driver cannot accept native permission dialogs; the actual toggles, permission checks, revocation, and network path are exercised. Bookmark/history permission dialogs use a simulated grant fixture; host permission revocation runs through the real browser API. Security regression checks verify CSP enforcement in pages and the worker, HTTPS custom-search validation (including retained legacy settings), reset cancellation and failed-revocation feedback, individual-site grant removal, and cleanup of overlays after permission removal. Unit tests cover handoff races, stale placeholders, and explicit destinations. Provider responses are deterministic; tests also cover stale requests, source filters, malformed responses, and network failures. Settings checks exercise rendered fonts (including actual platform font selection), every appearance control, presentation toggles, clock updates, starting scopes, result limits, destination behavior in overlays, all built-in search providers, and shortcut settings. Preview tests cover keyboard use and narrow layouts. Dia-specific homepage events use deterministic unit fixtures; the real browser integration tests run in Chromium. Visual captures are written to `test-results/`.

`npm run package` produces a clean unpacked folder and `dist/dia-command-bar-1.4.0.zip`. Load the folder into the browser; unzip the archive before loading it. The ZIP is suitable for sharing or preparing a store submission, but has not been published or reviewed by a browser store.

## Platform references

- [Chrome: override pages and new-tab focus](https://developer.chrome.com/docs/extensions/develop/ui/override-chrome-pages)
- [Chrome: extension shortcuts and reserved combinations](https://developer.chrome.com/docs/extensions/reference/api/commands)
- [Chrome: load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Dia release notes](https://www.diabrowser.com/changelog/mac)
- [Chromium: Google suggestions integration](https://chromium.googlesource.com/chromium/src/+/main/components/omnibox/browser/remote_suggestions_service_unittest.cc)
- [Chrome: optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)

Independent project; not affiliated with The Browser Company, Dia, or Arc.

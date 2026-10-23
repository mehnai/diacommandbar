# Dia Command Bar

A lightweight, Arc-inspired command bar for Dia and other Chromium browsers. It replaces the standard Chromium new tab page and opens as an overlay on websites with **⌘⇧L** on Mac or **Ctrl+Shift+L** on Windows/Linux. An optional setting also turns **⌘T / Ctrl+T** into an overlay over your previous website.

## Install in Dia

1. Open `chrome://extensions` in Dia (or use **Extensions → Manage Extensions**).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder, which contains `manifest.json`. You can also select the clean `dist/dia-command-bar` folder after running `npm run package`.
4. Pin **Dia Command Bar** in the extensions menu.
5. Press **⌘⇧L** on a website, or click the extension icon.
6. For **⌘T / Ctrl+T**, open **Settings → Overlay → Open new tabs as an overlay**, enable it, and allow website access. Return to a website and open a new tab to try it.

There is no build step and no account to set up. Keep the installed folder in place. After changing source files, click **Reload** on the extension card and refresh any open command bar pages.

### Dia and the new tab shortcut

By default, **⌘T / Ctrl+T** opens the full command page. Enable **Settings → Overlay → Open new tabs as an overlay** to open the command bar over the previous website instead. The option is off by default and requests optional HTTP/HTTPS website access: the new-tab shortcut does not grant the extension temporary access to the previous page.

The browser still creates a new tab first. When that fresh, empty tab loads the extension, it opens an overlay on the previous tab in the same window, waits for the overlay to respond, switches back, and closes only the temporary new tab. A brief tab flash is possible. Existing command pages, background tabs, explicit destinations, and tabs where navigation has started are kept. If there is no previous website, or the page cannot show the overlay, the full command page stays available. Turning the option off removes its broad website permission. Chromium may also remove a Google grant covered by that permission; if so, settings explains that you need to enable search suggestions again.

This uses the standard `chrome_url_overrides.newtab` override; it cannot reassign the browser's reserved shortcut. Dia also has a separate `chrome://start-page/<UUID>` homepage that bypasses this override. For a newly created foreground tab, the extension recognizes that address and navigates the same tab to its command page. With **Open new tabs as an overlay** enabled, the normal handoff to your previous website can then run. Otherwise, or in a new window with no previous website, the command page stays open. Dia's native page may briefly appear before the redirect.

The Dia workaround only considers tabs created within the last ten seconds, and waits for the actual homepage address rather than treating an empty URL as a homepage. Dia initially reports its new homepage as an inactive tab with an opener; the extension waits for it to become active before redirecting. It ignores pre-existing tabs, pinned/discarded tabs, deeper chat paths, and pages with query strings. A tab that starts navigating to another destination is no longer a candidate. This uses existing permissions and adds no dependencies. Dia's undocumented internal address can change between browser versions.

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

The overlay opens destinations in a new tab so your current page stays available. Selecting an open tab switches to it. Selecting a destination from the full new-tab page uses that tab, unless you hold Command/Control or choose **Settings → Search → Open results in → A new tab**. New-tab overlay mode closes only the empty tab it just received; your existing tabs stay open.

The overlay background is transparent, with no page dimming or blur. Its embedded page is clipped to the visible controls so an opaque browser canvas cannot hide the surrounding website. Drag the small grip at the top to move the bar; double-click it to center the bar again. You can also focus the grip with Shift+Tab from the search field, move it with the arrow keys (Shift for larger steps), and press Home to center it. The bar stays within the window when results grow or the window resizes, and starts centered unless **Settings → Overlay → Remember where I moved it** is on. Remembered positions last for the browser session; double-click or Home clears the saved position. Outside-click dismissal can also be turned off. Dragging uses native pointer events with no added dependencies or permissions.

## Customize

Open **Settings** in the bar footer, press **⌘, / Ctrl+,**, or type **> settings**. Settings use text choices and small steppers, with seven sections:

- **Appearance:** system/light/dark, monochrome or blue/green/orange/red accents, UI/serif/mono font, spacing, roundness, width, and higher contrast.
- **Command bar:** inverted or soft selection, filters, icons, result labels, number labels, and keyboard hints. Hiding hints keeps the settings shortcut and action available.
- **New tab:** live date/time, 12/24-hour format, position, and plain or dot-grid background.
- **Search:** default/Google/DuckDuckGo/Bing/Brave/custom engine, optional Google suggestions, 3–10 local results, and where destinations open. Custom addresses must use HTTPS, contain `%s` for the encoded query, and have no credentials.
- **Sources:** default scope, current/all windows, optional bookmarks/history, and a 7/30/90-day history range. Clear/Escape resets to the default scope.
- **Overlay:** new-tab handoff, outside-click dismissal, and remembered position.
- **Shortcuts:** actual browser binding, palette keys, and a link to browser shortcut settings.

Preferences stay in this browser profile. The old lilac/sage/rose/sand accents migrate to monochrome; existing search, theme, and overlay preferences are retained. **Restore defaults** resets customization, turns off autocomplete and new-tab overlays, clears remembered position, and revokes all optional bookmark, history, Google, and HTTP/HTTPS site grants (including individual-site grants). It cancels pending suggestions and verifies that the grants were removed. If the browser refuses, it reports the failure rather than claiming success. Features require enabling and granting access again. Existing HTTP custom search templates are rejected; replace them with an HTTPS template in Settings → Search.

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

The embedded command page verifies its extension origin and a per-tab token before accepting privileged operations. Window messages carry only control bounds and outside-click dismissal; external websites cannot issue browser commands through them. Website text is rendered as text, never HTML. Executable URLs and URLs containing credentials are rejected.

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

Browser tests load the real extension into an isolated Chromium profile and cover the new-tab override and overlay handoff, tab switching, navigation, settings, overlay lifecycle, restricted-page fallback, authorization boundaries, and autocomplete/website permission interactions. Optional hosts are pre-granted through Chromium's extension-management API because the headless driver cannot accept native permission dialogs; the actual toggles, permission checks, revocation, and network path are exercised. Unit tests cover handoff races, stale placeholders, and explicit destinations. Provider responses are deterministic; tests also cover stale requests, source filters, malformed responses, and network failures. Preview tests cover keyboard use and narrow layouts. Visual captures are written to `test-results/`.

`npm run package` produces a clean unpacked folder and `dist/dia-command-bar-1.3.1.zip`. Load the folder into the browser; unzip the archive before loading it. The ZIP is suitable for sharing or preparing a store submission, but has not been published or reviewed by a browser store.

## Platform references

- [Chrome: override pages and new-tab focus](https://developer.chrome.com/docs/extensions/develop/ui/override-chrome-pages)
- [Chrome: extension shortcuts and reserved combinations](https://developer.chrome.com/docs/extensions/reference/api/commands)
- [Chrome: load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Dia release notes](https://www.diabrowser.com/changelog/mac)
- [Chromium: Google suggestions integration](https://chromium.googlesource.com/chromium/src/+/main/components/omnibox/browser/remote_suggestions_service_unittest.cc)
- [Chrome: optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)

Independent project; not affiliated with The Browser Company, Dia, or Arc.

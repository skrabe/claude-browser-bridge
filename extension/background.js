// Claude Browser Bridge — extension service worker.
// "Dumb hands": a generic CDP proxy + tab manager. The native host (com.claude.browserbridge)
// sends {id, method, params}; we execute via chrome.debugger / chrome.tabs and reply {id, result|error}.
// Every chrome.debugger event is streamed back as {method:"onCDPEvent", params}.
// No page reading/acting happens here — all of that is CDP driven by the host, exactly like Codex.

const HOST = 'com.claude.browserbridge';
let port = null;
const attached = new Set(); // tabIds we have chrome.debugger attached to

function connect() {
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    setTimeout(connect, 2000);
    return;
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // Detach everything so we never leave the browser in a debugged state.
    for (const tabId of [...attached]) detach(tabId).catch(() => {});
    setTimeout(connect, 1000);
  });
}
connect();

function reply(id, result, error) {
  if (!port || id === undefined) return;
  port.postMessage(error ? { id, error: String(error) } : { id, result });
}

async function onMessage(m) {
  const { id, method, params } = m || {};
  try {
    reply(id, await handle(method, params || {}));
  } catch (e) {
    reply(id, undefined, (e && e.message) || e);
  }
}

async function handle(method, p) {
  switch (method) {
    case 'getInfo':
      return { name: 'ClaudeBrowserBridge', backend: 'extension', cdp: '1.3' };

    // Codex-style: enumerate the user's real tabs across every window.
    case 'getUserTabs': {
      const tabs = await chrome.tabs.query({});
      const out = [];
      for (const t of tabs) {
        if (t.id == null) continue;
        let group = null;
        if (t.groupId != null && t.groupId !== -1) {
          try { group = (await chrome.tabGroups.get(t.groupId)).title || null; } catch {}
        }
        out.push({
          id: t.id, title: t.title, url: t.url, windowId: t.windowId,
          active: t.active, lastAccessed: t.lastAccessed, tabGroup: group,
        });
      }
      out.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      return { tabs: out };
    }

    // Codex-style: take control of an EXISTING tab in place (no new tab).
    case 'claimTab': {
      if (typeof p.tabId !== 'number') throw new Error('claimTab requires tabId');
      const tab = await chrome.tabs.get(p.tabId);
      if (tab.url && tab.url.startsWith('chrome://')) throw new Error('cannot claim chrome:// tab');
      await attach(p.tabId);
      return { id: p.tabId, title: tab.title, url: tab.url, claimed: true };
    }

    case 'createTab': {
      const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: !!p.active });
      await attach(tab.id);
      return { id: tab.id, url: tab.url };
    }

    // Raw CDP passthrough — the workhorse. Host composes Page/DOM/Input/Runtime/etc.
    case 'executeCdp': {
      if (typeof p.tabId !== 'number') throw new Error('executeCdp requires tabId');
      if (!attached.has(p.tabId)) await attach(p.tabId);
      return await chrome.debugger.sendCommand({ tabId: p.tabId }, p.cdpMethod, p.cdpParams || {});
    }

    case 'activateTab': {
      await chrome.tabs.update(p.tabId, { active: true });
      return { ok: true };
    }

    case 'closeTab': {
      await detach(p.tabId).catch(() => {});
      await chrome.tabs.remove(p.tabId);
      return { ok: true };
    }

    case 'release': { // detach without closing — hand the tab back to the user
      await detach(p.tabId);
      return { ok: true };
    }

    default:
      throw new Error('unknown method: ' + method);
  }
}

function attach(tabId) {
  return new Promise((res, rej) => {
    if (attached.has(tabId)) return res();
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) return rej(chrome.runtime.lastError.message);
      attached.add(tabId);
      res();
    });
  });
}

function detach(tabId) {
  return new Promise((res) => {
    if (!attached.has(tabId)) return res();
    chrome.debugger.detach({ tabId }, () => { attached.delete(tabId); res(); });
  });
}

chrome.debugger.onEvent.addListener((source, cdpMethod, cdpParams) => {
  if (!port) return;
  port.postMessage({ method: 'onCDPEvent', params: { source, cdpMethod, cdpParams } });
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

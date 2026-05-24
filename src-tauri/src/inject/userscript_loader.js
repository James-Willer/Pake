(async function() {
  try {
    // Wait until window.__TAURI__ is initialized
    if (!window.__TAURI__) {
      await new Promise(resolve => {
        const interval = setInterval(() => {
          if (window.__TAURI__) {
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });
    }

    // Clear previous page's menu commands on load
    if (window.top === window) {
      window.__TAURI__.core.invoke("clear_menu_commands").catch(() => {});
    }

    const scripts = await window.__TAURI__.core.invoke("get_userscripts");
    if (!scripts || !Array.isArray(scripts)) return;
    
    const currentUrl = window.location.href;
    
    function patternToRegex(pattern) {
      if (pattern === '<all_urls>') return /.*/;
      // Convert wildcards to regexes
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                            .replace(/\*/g, '.*')
                            .replace(/\?/g, '.');
      return new RegExp('^' + escaped + '$');
    }

    function parseMetadata(code) {
      const metadata = {
        name: '',
        version: '',
        namespace: '',
        description: '',
        author: '',
        homepage: '',
        icon: '',
        matches: [],
        includes: [],
        excludes: [],
        resources: {},
        requires: [],
        grants: [],
        runAt: 'document-end',
        noframes: false,
        unwrap: false
      };
      
      const match = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
      if (!match) return metadata;
      
      const lines = match[1].split('\n');
      for (const line of lines) {
        const parts = line.match(/\/\/\s*@(\S+)\s+(.+)$/);
        if (parts) {
          const key = parts[1].trim();
          const val = parts[2].trim();
          switch (key) {
            case 'match': metadata.matches.push(val); break;
            case 'include': metadata.includes.push(val); break;
            case 'exclude': metadata.excludes.push(val); break;
            case 'require': metadata.requires.push(val); break;
            case 'resource':
              const resParts = val.match(/^(\S+)\s+(.+)$/);
              if (resParts) metadata.resources[resParts[1]] = resParts[2];
              break;
            case 'grant': metadata.grants.push(val); break;
            case 'run-at': metadata.runAt = val; break;
            case 'name': metadata.name = val; break;
            case 'version': metadata.version = val; break;
            case 'namespace': metadata.namespace = val; break;
            case 'description': metadata.description = val; break;
            case 'author': metadata.author = val; break;
            case 'homepage':
            case 'homepageURL':
            case 'website':
              metadata.homepage = val;
              break;
            case 'icon':
            case 'iconURL':
            case 'defaulticon':
              metadata.icon = val;
              break;
            case 'noframes': metadata.noframes = true; break;
            case 'unwrap': metadata.unwrap = true; break;
          }
        } else if (line.match(/\/\/\s*@noframes/)) {
          metadata.noframes = true;
        } else if (line.match(/\/\/\s*@unwrap/)) {
          metadata.unwrap = true;
        }
      }
      return metadata;
    }

    // Callbacks container for GM menu commands
    window.__pake_registered_callbacks = window.__pake_registered_callbacks || {};
    window.__pake_trigger_menu_command = (scriptId, name) => {
      const key = scriptId + '::' + name;
      if (window.__pake_registered_callbacks && window.__pake_registered_callbacks[key]) {
        try {
          window.__pake_registered_callbacks[key]();
        } catch (e) {
          console.error(`[Pake Userscript] Error running menu command:`, e);
        }
      }
    };

    const valueChangeListeners = {}; // Format: "scriptId::key" -> { "scriptId::key::listenerId": callback }

    // Listen for userscript setting changes
    if (window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
      window.__TAURI__.event.listen('userscript-setting-changed', (event) => {
        const { script_id, key, value, sender } = event.payload;
        
        // Find if this script is currently loaded and update its settings
        for (const s of scripts) {
          if (s.id === script_id) {
            s.settings = s.settings || {};
            const oldVal = s.settings[key];
            if (value === null || value === undefined) {
              delete s.settings[key];
            } else {
              s.settings[key] = value;
            }
            
            // Trigger any registered listeners for this key in this script
            const keyListeners = valueChangeListeners[script_id + '::' + key];
            if (keyListeners) {
              const isRemote = sender !== window.__TAURI__.window.getCurrentWindow().label;
              if (isRemote) {
                for (const listener of Object.values(keyListeners)) {
                  try {
                    listener(key, oldVal, value, true);
                  } catch (e) {
                    console.error(`[Pake Userscript] Error in value change listener:`, e);
                  }
                }
              }
            }
          }
        }
      }).catch(err => console.error("[Pake Userscript] Failed to listen to setting changes:", err));
    }

    for (const script of scripts) {
      if (!script.enabled) continue;
      
      const meta = parseMetadata(script.code);
      
      if (meta.noframes && window.top !== window) continue;

      let shouldRun = (meta.matches.length === 0 && meta.includes.length === 0);
      
      for (const pattern of [...meta.matches, ...meta.includes]) {
        const regex = patternToRegex(pattern);
        if (regex.test(currentUrl)) {
          shouldRun = true;
          break;
        }
      }
      
      for (const pattern of meta.excludes) {
        const regex = patternToRegex(pattern);
        if (regex.test(currentUrl)) {
          shouldRun = false;
          break;
        }
      }
      
      if (shouldRun) {
        const runScript = () => {
          try {
            const context = {
              GM_info: {
                script: {
                  name: script.name,
                  version: meta.version || '1.0.0',
                  namespace: meta.namespace || '',
                  description: meta.description || '',
                  author: meta.author || '',
                  homepage: meta.homepage || '',
                  icon: meta.icon || '',
                  includes: meta.includes || [],
                  matches: meta.matches || [],
                  excludes: meta.excludes || [],
                  resources: Object.keys(script.resources || {}).map(name => ({ name })),
                  runAt: meta.runAt,
                  unwrap: meta.unwrap
                },
                scriptHandler: 'Pake Userscript Manager',
                version: '1.1.0'
              },
              unsafeWindow: window
            };

            const GM_addStyle = (css) => {
              const style = document.createElement('style');
              style.textContent = css;
              document.head.appendChild(style);
              return style;
            };

            const GM_addElement = (tagName, attributes) => {
              const el = document.createElement(tagName);
              if (attributes) {
                for (const [k, v] of Object.entries(attributes)) {
                  if (k === 'textContent') el.textContent = v;
                  else el.setAttribute(k, v);
                }
              }
              (document.head || document.body || document.documentElement).appendChild(el);
              return el;
            };

            const GM_getResourceText = (name) => {
              return (script.resources && script.resources[name]) || null;
            };

            const GM_getResourceURL = (name) => {
              const text = GM_getResourceText(name);
              if (!text) return null;
              // Try to detect if it's already a data URL or base64
              if (text.startsWith('data:')) return text;
              return `data:text/plain;base64,${btoa(text)}`;
            };

            script.settings = script.settings || {};
            const scriptSettings = script.settings;
            
            const GM_getValue = (key, defaultValue) => {
              return scriptSettings[key] !== undefined ? scriptSettings[key] : defaultValue;
            };

            const GM_setValue = (key, value) => {
              const oldVal = scriptSettings[key];
              scriptSettings[key] = value;
              window.__TAURI__.core.invoke("save_userscript_setting", {
                scriptId: script.id,
                key: key,
                value: value
              }).catch(err => console.error("[Pake Userscript] GM_setValue error:", err));
              
              // Trigger listeners inside current window immediately
              const keyListeners = valueChangeListeners[script.id + '::' + key];
              if (keyListeners) {
                for (const listener of Object.values(keyListeners)) {
                  try {
                    listener(key, oldVal, value, false);
                  } catch (e) {
                    console.error(`[Pake Userscript] Error in value change listener:`, e);
                  }
                }
              }
            };

            const GM_deleteValue = (key) => {
              const oldVal = scriptSettings[key];
              delete scriptSettings[key];
              window.__TAURI__.core.invoke("save_userscript_setting", {
                scriptId: script.id,
                key: key,
                value: null
              }).catch(err => console.error("[Pake Userscript] GM_deleteValue error:", err));
              
              // Trigger listeners inside current window immediately
              const keyListeners = valueChangeListeners[script.id + '::' + key];
              if (keyListeners) {
                for (const listener of Object.values(keyListeners)) {
                  try {
                    listener(key, oldVal, undefined, false);
                  } catch (e) {
                    console.error(`[Pake Userscript] Error in value change listener:`, e);
                  }
                }
              }
            };

            const GM_listValues = () => {
              return Object.keys(scriptSettings);
            };

            let nextListenerId = 1;
            const myListeners = new Map();

            const GM_addValueChangeListener = (key, callback) => {
              const listenerId = nextListenerId++;
              const globalKey = script.id + '::' + key;
              valueChangeListeners[globalKey] = valueChangeListeners[globalKey] || {};
              const globalListenerId = script.id + '::' + key + '::' + listenerId;
              valueChangeListeners[globalKey][globalListenerId] = callback;
              myListeners.set(listenerId, { key, globalListenerId });
              return listenerId;
            };

            const GM_removeValueChangeListener = (listenerId) => {
              const info = myListeners.get(listenerId);
              if (info) {
                const globalKey = script.id + '::' + info.key;
                if (valueChangeListeners[globalKey]) {
                  delete valueChangeListeners[globalKey][info.globalListenerId];
                }
                myListeners.delete(listenerId);
              }
            };

            const GM_download = (details, name) => {
              let url = '';
              let filename = '';
              let onload = null;
              let onerror = null;

              if (typeof details === 'string') {
                url = details;
                filename = name;
              } else if (details && typeof details === 'object') {
                url = details.url;
                filename = details.name || details.filename;
                onload = details.onload;
                onerror = details.onerror;
              }

              if (!url || !filename) {
                if (typeof onerror === 'function') {
                  onerror({ error: 'not_supported', details: 'Missing URL or filename' });
                }
                return { abort: () => {} };
              }

              const processDownload = async () => {
                try {
                  let binaryData = null;
                  if (url instanceof Blob) {
                    const arrayBuffer = await url.arrayBuffer();
                    binaryData = Array.from(new Uint8Array(arrayBuffer));
                  } else if (typeof url === 'string' && (url.startsWith('blob:') || url.startsWith('data:'))) {
                    const response = await fetch(url);
                    const arrayBuffer = await response.arrayBuffer();
                    binaryData = Array.from(new Uint8Array(arrayBuffer));
                  }

                  if (binaryData !== null) {
                    await window.__TAURI__.core.invoke("download_file_by_binary", {
                      filename,
                      binary: binaryData,
                      language: 'en'
                    });
                  } else {
                    await window.__TAURI__.core.invoke("download_file", {
                      url,
                      filename,
                      language: 'en'
                    });
                  }

                  if (typeof onload === 'function') onload();
                } catch (err) {
                  console.error("[Pake Userscript] GM_download error:", err);
                  if (typeof onerror === 'function') onerror({ error: 'download_failed', details: err.toString() });
                }
              };

              processDownload();
              return { abort: () => {} };
            };

            const GM_log = (...args) => {
              console.log(`[Userscript: ${script.name}]`, ...args);
            };

            const GM_notification = (details, ondone) => {
              let title = 'Userscript Notification';
              let body = '';
              let icon = meta.icon || '';
              if (typeof details === 'string') {
                body = details;
              } else if (details && typeof details === 'object') {
                title = details.title || title;
                body = details.text || details.body || '';
                icon = details.image || details.icon || icon;
              }
              window.__TAURI__.core.invoke("send_notification", {
                params: { title, body, icon }
              }).then(() => {
                if (typeof ondone === 'function') ondone();
              }).catch(err => console.error("[Pake Userscript] GM_notification error:", err));
            };

            const GM_openInTab = (url, options) => {
              window.__TAURI__.core.invoke("plugin:opener|open", { path: url })
                .catch(err => console.error("[Pake Userscript] GM_openInTab error:", err));
              return {
                close: () => {},
                onclose: null,
                closed: false
              };
            };

            const GM_setClipboard = (data, info) => {
              window.__TAURI__.core.invoke("set_clipboard", { data })
                .catch(err => console.error("[Pake Userscript] GM_setClipboard error:", err));
            };

            let menuCommandIdCounter = 1;
            const menuCommandIdMap = new Map();

            const GM_registerMenuCommand = (name, fn) => {
              const id = menuCommandIdCounter++;
              const nameStr = name.toString();
              menuCommandIdMap.set(id, nameStr);
              window.__pake_registered_callbacks[script.id + '::' + nameStr] = fn;
              window.__TAURI__.core.invoke("register_menu_command", { scriptId: script.id, name: nameStr })
                .catch(err => console.error("[Pake Userscript] GM_registerMenuCommand error:", err));
              return id;
            };

            const GM_unregisterMenuCommand = (id) => {
              const nameStr = menuCommandIdMap.get(id) || (id ? id.toString() : '');
              delete window.__pake_registered_callbacks[script.id + '::' + nameStr];
              window.__TAURI__.core.invoke("unregister_menu_command", { scriptId: script.id, name: nameStr })
                .catch(err => console.error("[Pake Userscript] GM_unregisterMenuCommand error:", err));
            };

            const GM_xmlhttpRequest = (details) => {
              const cleanedHeaders = {};
              if (details.headers) {
                for (const [k, v] of Object.entries(details.headers)) {
                  if (v !== null && v !== undefined) {
                    cleanedHeaders[k] = v.toString();
                  }
                }
              }
              const invokeArgs = {
                details: {
                  url: details.url,
                  method: details.method || 'GET',
                  headers: cleanedHeaders,
                  body: details.data || null,
                }
              };
              window.__TAURI__.core.invoke("gm_xmlhttprequest", { details: invokeArgs.details })
                .then(resp => {
                  const responseObj = {
                    status: resp.status,
                    statusText: resp.status_text,
                    headers: resp.headers,
                    responseText: resp.response_text,
                    response: resp.response_text,
                    readyState: 4,
                    finalUrl: details.url
                  };
                  if (typeof details.onload === 'function') details.onload(responseObj);
                })
                .catch(err => {
                  if (typeof details.onerror === 'function') details.onerror(err);
                });
            };

            // GM.* Async API support
            const GM = {
              info: context.GM_info,
              setValue: async (k, v) => GM_setValue(k, v),
              getValue: async (k, d) => GM_getValue(k, d),
              deleteValue: async (k) => GM_deleteValue(k),
              listValues: async () => GM_listValues(),
              getResourceURL: async (n) => GM_getResourceURL(n),
              notification: async (d, c) => GM_notification(d, c),
              openInTab: async (u, o) => GM_openInTab(u, o),
              setClipboard: async (d, i) => GM_setClipboard(d, i),
              xmlHttpRequest: (d) => GM_xmlhttpRequest(d),
              download: async (d, n) => GM_download(d, n),
              addValueChangeListener: async (k, c) => GM_addValueChangeListener(k, c),
              removeValueChangeListener: async (id) => GM_removeValueChangeListener(id)
            };

            const apiList = {
              GM_addStyle, GM_addElement, GM_getResourceText, GM_getResourceURL, 
              GM_getValue, GM_setValue, GM_deleteValue, GM_listValues, GM_log,
              GM_info: context.GM_info, GM_notification, GM_openInTab, 
              GM_setClipboard, GM_registerMenuCommand, GM_unregisterMenuCommand,
              GM_xmlhttpRequest, GM_download, GM_addValueChangeListener, GM_removeValueChangeListener,
              GM, unsafeWindow: window
            };

            const fullCode = (script.requires || []).join('\n;\n') + '\n;\n' + script.code;

            const apiKeys = Object.keys(apiList);
            const apiValues = Object.values(apiList);

            const fn = new Function(...apiKeys, 
              `"use strict";\n${fullCode}\n//# sourceURL=userscript://${encodeURIComponent(script.name)}`
            );
            
            fn(...apiValues);
            
            console.log(`[Pake Userscript] Successfully ran: ${script.name}`);
          } catch (e) {
            console.error(`[Pake Userscript] Error running ${script.name}:`, e);
          }
        };

        if (meta.runAt === 'document-start') {
          runScript();
        } else if (meta.runAt === 'document-idle') {
          if (document.readyState === 'complete') {
            runScript();
          } else {
            window.addEventListener('load', runScript);
          }
        } else { 
          if (document.readyState === 'interactive' || document.readyState === 'complete') {
            runScript();
          } else {
            document.addEventListener('DOMContentLoaded', runScript);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Pake Userscript Loader] Error:', err);
  }
})();

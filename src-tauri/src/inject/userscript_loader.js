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
        matches: [],
        excludes: [],
        runAt: 'document-end'
      };
      
      const match = code.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
      if (!match) return metadata;
      
      const lines = match[1].split('\n');
      for (const line of lines) {
        const parts = line.match(/\/\/\s*@(\S+)\s+(.+)$/);
        if (parts) {
          const key = parts[1].trim();
          const val = parts[2].trim();
          if (key === 'match' || key === 'include') {
            metadata.matches.push(val);
          } else if (key === 'exclude') {
            metadata.excludes.push(val);
          } else if (key === 'run-at') {
            metadata.runAt = val;
          } else if (key === 'name') {
            metadata.name = val;
          } else if (key === 'version') {
            metadata.version = val;
          } else if (key === 'namespace') {
            metadata.namespace = val;
          } else if (key === 'description') {
            metadata.description = val;
          }
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

    for (const script of scripts) {
      if (!script.enabled) continue;
      
      const meta = parseMetadata(script.code);
      
      let shouldRun = meta.matches.length === 0;
      for (const pattern of meta.matches) {
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
            const GM_addStyle = (css) => {
              const style = document.createElement('style');
              style.textContent = css;
              document.head.appendChild(style);
              return style;
            };

            const GM_getResourceText = (name) => {
              return (script.resources && script.resources[name]) || null;
            };

            const scriptSettings = script.settings || {};
            const GM_getValue = (key, defaultValue) => {
              return scriptSettings[key] !== undefined ? scriptSettings[key] : defaultValue;
            };

            const GM_setValue = (key, value) => {
              scriptSettings[key] = value;
              window.__TAURI__.core.invoke("save_userscript_setting", {
                scriptId: script.id,
                key: key,
                value: value
              }).catch(err => console.error("[Pake Userscript] GM_setValue error:", err));
            };

            const GM_info = {
              script: {
                name: script.name,
                version: meta.version || '1.0.0',
                namespace: meta.namespace || '',
                description: meta.description || '',
                includes: meta.matches || [],
                matches: meta.matches || [],
                excludes: meta.excludes || [],
                resources: Object.keys(script.resources || {}).map(name => ({ name })),
              },
              scriptHandler: 'Pake Userscript Manager',
              version: '1.0.0'
            };

            const GM_notification = (details, ondone) => {
              let title = 'Userscript Notification';
              let body = '';
              if (typeof details === 'string') {
                body = details;
              } else if (details && typeof details === 'object') {
                title = details.title || title;
                body = details.text || details.body || '';
              }
              window.__TAURI__.core.invoke("send_notification", {
                params: { title, body, icon: '' }
              }).then(() => {
                if (typeof ondone === 'function') ondone();
              }).catch(err => console.error("[Pake Userscript] GM_notification error:", err));
            };

            const GM_openInTab = (url) => {
              window.__TAURI__.core.invoke("plugin:opener|open", { path: url })
                .catch(err => console.error("[Pake Userscript] GM_openInTab error:", err));
              return {
                close: () => {},
                onclose: null,
                closed: false
              };
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
                  };
                  if (typeof details.onload === 'function') {
                    details.onload(responseObj);
                  }
                })
                .catch(err => {
                  if (typeof details.onerror === 'function') {
                    details.onerror(err);
                  }
                });
            };

            const fullCode = (script.requires || []).join('\n;\n') + '\n;\n' + script.code;

            const fn = new Function(
              'GM_addStyle', 'GM_getResourceText', 'GM_getValue', 'GM_setValue', 'GM_info',
              'GM_notification', 'GM_openInTab', 'GM_registerMenuCommand', 'GM_unregisterMenuCommand',
              'GM_xmlhttpRequest',
              fullCode + "\n//# sourceURL=userscript://" + encodeURIComponent(script.name)
            );
            
            fn(
              GM_addStyle, GM_getResourceText, GM_getValue, GM_setValue, GM_info,
              GM_notification, GM_openInTab, GM_registerMenuCommand, GM_unregisterMenuCommand,
              GM_xmlhttpRequest
            );
            
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

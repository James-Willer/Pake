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

    window.__pake_menu_commands = window.__pake_menu_commands || [];

    function updateFloatingMenuUI() {
      if (window.__pake_menu_commands.length === 0) {
        const existing = document.getElementById('pake-userscript-menu-root');
        if (existing) existing.remove();
        return;
      }

      let root = document.getElementById('pake-userscript-menu-root');
      if (!root) {
        root = document.createElement('div');
        root.id = 'pake-userscript-menu-root';
        root.style.cssText = `
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 999999;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;
        
        const btn = document.createElement('button');
        btn.id = 'pake-userscript-menu-btn';
        btn.innerHTML = '⚙️';
        btn.style.cssText = `
          width: 44px;
          height: 44px;
          border-radius: 50%;
          background: rgba(18, 18, 20, 0.85);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: white;
          font-size: 20px;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
        `;
        btn.onmouseover = () => {
          btn.style.transform = 'rotate(45deg) scale(1.05)';
          btn.style.background = '#4f46e5';
        };
        btn.onmouseout = () => {
          btn.style.transform = 'rotate(0) scale(1)';
          btn.style.background = 'rgba(18, 18, 20, 0.85)';
        };
        
        const menu = document.createElement('div');
        menu.id = 'pake-userscript-menu-list';
        menu.style.cssText = `
          position: absolute;
          bottom: 55px;
          right: 0;
          width: 240px;
          background: rgba(18, 18, 20, 0.95);
          backdrop-filter: blur(15px);
          -webkit-backdrop-filter: blur(15px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
          padding: 8px 0;
          display: none;
          flex-direction: column;
          max-height: 300px;
          overflow-y: auto;
        `;
        
        btn.onclick = (e) => {
          e.stopPropagation();
          const isHidden = menu.style.display === 'none';
          menu.style.display = isHidden ? 'flex' : 'none';
        };
        
        document.addEventListener('click', () => {
          menu.style.display = 'none';
        });
        
        root.appendChild(menu);
        root.appendChild(btn);
        
        if (document.body) {
          document.body.appendChild(root);
        } else {
          document.addEventListener('DOMContentLoaded', () => {
            document.body.appendChild(root);
          });
        }
      }

      const menuList = document.getElementById('pake-userscript-menu-list');
      if (menuList) {
        menuList.innerHTML = '';
        
        const grouped = {};
        window.__pake_menu_commands.forEach(cmd => {
          if (!grouped[cmd.scriptName]) grouped[cmd.scriptName] = [];
          grouped[cmd.scriptName].push(cmd);
        });
        
        Object.keys(grouped).forEach(scriptName => {
          const header = document.createElement('div');
          header.textContent = scriptName;
          header.style.cssText = `
            padding: 6px 12px;
            font-size: 11px;
            color: #8e9cae;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          `;
          menuList.appendChild(header);
          
          grouped[scriptName].forEach(cmd => {
            const item = document.createElement('button');
            item.textContent = cmd.name;
            item.style.cssText = `
              background: transparent;
              border: none;
              color: #f1f5f9;
              padding: 8px 12px;
              text-align: left;
              font-size: 13px;
              cursor: pointer;
              width: 100%;
              transition: background 0.15s;
            `;
            item.onmouseover = () => {
              item.style.background = 'rgba(255, 255, 255, 0.08)';
            };
            item.onmouseout = () => {
              item.style.background = 'transparent';
            };
            item.onclick = (e) => {
              e.stopPropagation();
              menuList.style.display = 'none';
              try {
                cmd.fn();
              } catch (err) {
                console.error(`Error running menu command ${cmd.name}:`, err);
              }
            };
            menuList.appendChild(item);
          });
        });
      }
    }

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

            const GM_registerMenuCommand = (name, fn) => {
              window.__pake_menu_commands = window.__pake_menu_commands.filter(c => !(c.name === name && c.scriptName === script.name));
              window.__pake_menu_commands.push({ name, fn, scriptName: script.name });
              updateFloatingMenuUI();
            };

            const GM_unregisterMenuCommand = (name) => {
              window.__pake_menu_commands = window.__pake_menu_commands.filter(c => !(c.name === name && c.scriptName === script.name));
              updateFloatingMenuUI();
            };

            const GM_xmlhttpRequest = (details) => {
              const invokeArgs = {
                details: {
                  url: details.url,
                  method: details.method || 'GET',
                  headers: details.headers || {},
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

            const fn = new Function(
              'GM_addStyle', 'GM_getResourceText', 'GM_getValue', 'GM_setValue', 'GM_info',
              'GM_notification', 'GM_openInTab', 'GM_registerMenuCommand', 'GM_unregisterMenuCommand',
              'GM_xmlhttpRequest',
              script.code + "\n//# sourceURL=userscript://" + encodeURIComponent(script.name)
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

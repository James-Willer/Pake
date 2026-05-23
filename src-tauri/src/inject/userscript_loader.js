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
          }
        }
      }
      return metadata;
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
            const fn = new Function(script.code + "\n//# sourceURL=userscript://" + encodeURIComponent(script.name));
            fn();
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

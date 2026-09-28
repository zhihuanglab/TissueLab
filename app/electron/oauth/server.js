/**
 * Minimal local HTTP server for OAuth callback handling
 * Listens on 127.0.0.1 (loopback) to receive authorization code
 * Immediately 302-redirects the browser to https://tissuelab.org/auth
 */

const http = require('http');
const { URL } = require('url');

/**
 * Create a local HTTP server to handle OAuth callback
 * For Desktop apps, Google expects the callback at the root path (no subpath)
 * @param {number} port - Port to listen on (default: 42813)
 * @param {string} callbackPath - Path to handle callback (default: '/' for Desktop apps)
 * @returns {Promise<{server: http.Server, port: number, getAuthorizationCode: Function}>}
 */
function createCallbackServer(port = 42813, callbackPath = '/') {
  return new Promise((resolve, reject) => {
    let authorizationCode = null;
    let error = null;
    let state = null;
    
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;
      
      // Handle callback path (root path for Desktop apps)
      if (pathname === callbackPath || pathname === '/') {
        const query = Object.fromEntries(parsedUrl.searchParams.entries());
        
        // Check for error
        if (query.error) {
          error = {
            error: query.error,
            error_description: query.error_description || 'Unknown error'
          };
          
          res.statusCode = 302;
          res.setHeader('Location', 'https://tissuelab.org/auth?status=error');
          res.end();
          
          return;
        }
        
        // Extract authorization code and state
        if (query.code) {
          authorizationCode = query.code;
          state = query.state || null;
          
          // Immediately redirect to official site; avoid showing any local UI
          res.statusCode = 302;
          res.setHeader('Location', 'https://tissuelab.org/auth');
          res.end();
          
          // Keep the callback server alive until the OAuth helper finishes
          // exchanging the code for tokens. Closing here can race with the
          // browser redirect or a second callback request.
        } else {
          // Browsers may request the bare loopback URL before Google sends
          // the OAuth callback. Do not turn that harmless request into a
          // terminal OAuth error; keep waiting for the request containing code.
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><title>Waiting for Google sign-in</title><p>Waiting for the TissueLab app to finish sign-in&hellip;</p>');
        }
      } else {
        // 404 for other paths
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });
    
    // Handle server errors
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Port is in use, try next port
        const nextPort = port + 1;
        console.log(`[OAuth] Port ${port} in use, trying ${nextPort}...`);
        resolve(createCallbackServer(nextPort, callbackPath));
      } else {
        reject(err);
      }
    });
    
    // Start listening
    // Use '127.0.0.1' as per Google's Desktop app documentation
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      const displayPath = callbackPath === '/' ? '' : callbackPath;
      console.log(`[OAuth] Callback server listening on http://127.0.0.1:${actualPort}${displayPath}`);
      
      // Function to wait for authorization code
      const getAuthorizationCode = (timeout = 300000) => { // 5 minute default timeout
        return new Promise((resolveCallback, rejectCallback) => {
          const timeoutId = setTimeout(() => {
            server.close();
            rejectCallback(new Error('OAuth timeout: User did not complete authentication in time'));
          }, timeout);
          
          // Check periodically if we have the code
          const checkInterval = setInterval(() => {
            if (authorizationCode) {
              clearTimeout(timeoutId);
              clearInterval(checkInterval);
              resolveCallback({ code: authorizationCode, state });
            } else if (error) {
              clearTimeout(timeoutId);
              clearInterval(checkInterval);
              rejectCallback(new Error(`OAuth error: ${error.error} - ${error.error_description}`));
            }
          }, 100);
          
          // Also check on server close
          server.on('close', () => {
            clearTimeout(timeoutId);
            clearInterval(checkInterval);
            if (authorizationCode) {
              resolveCallback({ code: authorizationCode, state });
            } else if (error) {
              rejectCallback(new Error(`OAuth error: ${error.error} - ${error.error_description}`));
            }
          });
        });
      };
      
      resolve({
        server,
        port: actualPort,
        getAuthorizationCode
      });
    });
  });
}

module.exports = {
  createCallbackServer
};


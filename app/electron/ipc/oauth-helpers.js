/**
 * Google OAuth 2.0 PKCE-based authentication helper
 * Implements secretless PKCE flow for desktop applications
 * 
 * @param {Object} params
 * @param {string} params.clientId - Google OAuth Client ID (UWP/Desktop app type)
 * @param {Function} params.openExternal - Function to open URL in system browser (shell.openExternal)
 * @returns {Promise<{success: boolean, tokens?: Object, error?: string}>}
 */
async function performGoogleOAuth({ clientId, clientSecret, openExternal }) {
  const { generatePKCEPair } = require('../oauth/pkce');
  const { createCallbackServer } = require('../oauth/server');
  const crypto = require('crypto');
  const https = require('https');
  const { URLSearchParams } = require('url');
  
  let callbackServer = null;
  
  try {
    console.log('[OAuth] Starting PKCE OAuth flow in system browser...');
    
    // Check if client ID is provided
    if (!clientId) {
      throw new Error('Google Client ID not provided. Please check your Firebase configuration.');
    }
    
    console.log('[OAuth] Using Client ID:', clientId.substring(0, 20) + '...');
    
    // Step 1: Generate PKCE parameters
    const { codeVerifier, codeChallenge } = generatePKCEPair();
    console.log('[OAuth] Generated PKCE parameters');
    
    // Step 2: Generate state parameter for CSRF protection
    const state = crypto.randomBytes(16).toString('hex');
    
    // Step 3: Create callback server
    // For Desktop apps, Google expects callback at root path (no subpath)
    // Use '127.0.0.1' as per Google's Desktop app documentation
    callbackServer = await createCallbackServer(42813, '/');
    const redirectUri = `http://127.0.0.1:${callbackServer.port}`;
    
    // Step 4: Build authorization URL
    const scopes = ['openid', 'email', 'profile'].join(' ');
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline'); // Request refresh token
    
    console.log('[OAuth] Authorization URL parameters:', {
      redirect_uri: redirectUri,
      code_challenge_length: codeChallenge.length,
      code_challenge_method: 'S256',
      state_length: state.length,
    });
    console.log('[OAuth] Opening browser for authentication...');
    
    // Step 5: Open system browser
    await openExternal(authUrl.toString());
    
    // Step 6: Wait for authorization code
    console.log('[OAuth] Waiting for authorization callback...');
    const { code: authorizationCode, state: returnedState } = await callbackServer.getAuthorizationCode(300000); // 5 min timeout
    
    // Step 7: Verify state parameter (CSRF protection)
    if (returnedState !== state) {
      throw new Error('State parameter mismatch - possible CSRF attack');
    }
    
    console.log('[OAuth] Authorization code received, exchanging for tokens...');
    
    // Step 8: Exchange authorization code for tokens (secretless PKCE)
    const tokenParams = {
      client_id: clientId,
      code: authorizationCode,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    };
    // Google's Desktop OAuth clients still require client_secret on token exchange
    // even when PKCE is used. The "secret" is non-confidential for installed apps.
    if (clientSecret) {
      tokenParams.client_secret = clientSecret;
    }
    
    const requestBody = new URLSearchParams(tokenParams).toString();
    
    // Use Node's native https module to ensure no extra headers are added
    const tokens = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'oauth2.googleapis.com',
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode !== 200) {
            let errorData;
            try {
              errorData = JSON.parse(data);
            } catch (e) {
              errorData = { error: 'parse_error', error_description: data };
            }
            
            console.error('[OAuth] Token exchange error details:', {
              status: res.statusCode,
              statusText: res.statusMessage,
              error: errorData.error,
              error_description: errorData.error_description,
              error_uri: errorData.error_uri,
              response_headers: res.headers,
            });
            reject(new Error(`Token exchange failed: ${errorData.error || res.statusMessage} - ${errorData.error_description || 'No description'}`));
            return;
          }
          
          try {
            const tokens = JSON.parse(data);
            resolve(tokens);
          } catch (e) {
            reject(new Error(`Failed to parse token response: ${e.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        console.error('[OAuth] Request error:', error);
        reject(error);
      });
      
      // Write the request body
      req.write(requestBody);
      req.end();
    });
    
    console.log('[OAuth] Successfully obtained tokens from Google');
    
    return {
      success: true,
      tokens: {
        access_token: tokens.access_token,
        id_token: tokens.id_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
      }
    };
  } catch (error) {
    console.error('[OAuth] Error during Google OAuth:', error);
    
    // Clean up server if it exists
    if (callbackServer && callbackServer.server) {
      try {
        callbackServer.server.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    
    return {
      success: false,
      error: error.message || 'Failed to authenticate with Google'
    };
  }
}

/**
 * Refresh Google OAuth tokens using refresh_token
 * 
 * @param {Object} params
 * @param {string} params.refreshToken - Google OAuth refresh token
 * @param {string} params.clientId - Google OAuth Client ID
 * @returns {Promise<{success: boolean, tokens?: Object, error?: string}>}
 */
async function refreshGoogleToken({ refreshToken, clientId, clientSecret }) {
  const https = require('https');
  const { URLSearchParams } = require('url');
  
  try {
    console.log('[OAuth] Refreshing access token...');
    
    if (!refreshToken || !clientId) {
      throw new Error('Refresh token and client ID are required');
    }
    
    // Build token refresh request
    const tokenParams = {
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    };
    if (clientSecret) {
      tokenParams.client_secret = clientSecret;
    }
    
    const requestBody = new URLSearchParams(tokenParams).toString();
    
    // Request new tokens from Google
    const tokens = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'oauth2.googleapis.com',
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode !== 200) {
            let errorData;
            try {
              errorData = JSON.parse(data);
            } catch (e) {
              errorData = { error: 'parse_error', error_description: data };
            }
            
            console.error('[OAuth] Token refresh error details:', {
              status: res.statusCode,
              statusText: res.statusMessage,
              error: errorData.error,
              error_description: errorData.error_description,
            });
            reject(new Error(`Token refresh failed: ${errorData.error || res.statusMessage} - ${errorData.error_description || 'No description'}`));
            return;
          }
          
          try {
            const tokens = JSON.parse(data);
            resolve(tokens);
          } catch (e) {
            reject(new Error(`Failed to parse token response: ${e.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        console.error('[OAuth] Token refresh request error:', error);
        reject(error);
      });
      
      req.write(requestBody);
      req.end();
    });
    
    // Validate required fields in token response
    if (!tokens.access_token || !tokens.id_token) {
      throw new Error('Invalid token response: missing required fields (access_token or id_token)');
    }
    
    console.log('[OAuth] Successfully refreshed tokens');
    
    return {
      success: true,
      tokens: {
        access_token: tokens.access_token,
        id_token: tokens.id_token,
        expires_in: tokens.expires_in,
        // Note: Google may not return a new refresh_token, use the existing one
      }
    };
  } catch (error) {
    console.error('[OAuth] Error during token refresh:', error);
    return {
      success: false,
      error: error.message || 'Failed to refresh token'
    };
  }
}

module.exports = {
  performGoogleOAuth,
  refreshGoogleToken
};


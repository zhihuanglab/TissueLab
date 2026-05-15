/**
 * PKCE (Proof Key for Code Exchange) utilities
 * Implements RFC 7636 for OAuth 2.0 public clients
 */

const crypto = require('crypto');

/**
 * Base64 URL-safe encoding (RFC 4648 Section 5)
 * Replaces + with -, / with _, and removes padding =
 */
function base64URLEncode(str) {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate a cryptographically random code verifier
 * Length: 43-128 characters (RFC 7636)
 */
function generateCodeVerifier() {
  // Generate 32 random bytes = 256 bits
  // Base64 encoding of 32 bytes = 44 characters (perfect for PKCE)
  const randomBytes = crypto.randomBytes(32);
  return base64URLEncode(randomBytes);
}

/**
 * Generate code challenge from code verifier using SHA256
 * Uses S256 method (SHA256) as recommended by RFC 7636
 * IMPORTANT: codeVerifier must be passed as UTF-8 string
 */
function generateCodeChallenge(codeVerifier) {
  // Explicitly encode as UTF-8 string to ensure consistent hashing
  const hash = crypto.createHash('sha256').update(codeVerifier, 'utf8').digest();
  return base64URLEncode(hash);
}

/**
 * Generate both code verifier and challenge
 * Returns: { codeVerifier, codeChallenge }
 */
function generatePKCEPair() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  
  return {
    codeVerifier,
    codeChallenge
  };
}

module.exports = {
  generatePKCEPair
};


const oauthManager = require('../utils/oauthManager');
const jobManager = require('../utils/jobManager');
const { passClientError } = require('../utils/httpError');

// Simple async handler for error handling
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const googlePhotosController = {
  // Get authentication status
  getAuthStatus: asyncHandler(async (req, res) => {
    try {
      const tokens = oauthManager.getStoredTokens(req.session);
      const isAuthenticated = tokens && tokens.access_token && !oauthManager.isTokenExpired(tokens);

      res.json({
        success: true,
        data: {
          authenticated: isAuthenticated,
          userInfo: isAuthenticated ? { email: tokens.userEmail || 'Unknown' } : null
        }
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      res.status(500).json({
        success: false,
        error: {
          code: 'AUTH_CHECK_FAILED',
          message: 'Failed to check authentication status',
          details: error.message
        }
      });
    }
  }),

  // Initiate OAuth flow
  initiateAuth: asyncHandler(async (req, res) => {
    try {
      const { redirectUri } = req.body;
      const authUrl = oauthManager.getAuthUrl(redirectUri);

      res.json({
        success: true,
        data: {
          authUrl,
          state: 'google-photos-auth'
        }
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      res.status(500).json({
        success: false,
        error: {
          code: 'AUTH_INIT_FAILED',
          message: 'Failed to initiate authentication',
          details: error.message
        }
      });
    }
  }),

  // Handle OAuth callback
  handleCallback: asyncHandler(async (req, res) => {
    try {
      const { code, state, error } = req.query;
      
      // Handle OAuth errors (user denied access, etc.)
      if (error) {
        console.log('OAuth error:', error);
        return res.send(`
          <html>
            <head><title>Google Photos Authentication</title></head>
            <body>
              <script>
                if (window.opener) {
                  window.opener.postMessage({
                    type: 'google-photos-auth',
                    success: false,
                    error: '${error === 'access_denied' ? 'Access denied by user' : 'Authentication failed'}'
                  }, '*');
                  window.close();
                } else {
                  window.location.href = '/admin';
                }
              </script>
            </body>
          </html>
        `);
      }
      
      if (!code) {
        return res.send(`
          <html>
            <head><title>Google Photos Authentication</title></head>
            <body>
              <script>
                if (window.opener) {
                  window.opener.postMessage({
                    type: 'google-photos-auth',
                    success: false,
                    error: 'No authorization code received'
                  }, '*');
                  window.close();
                } else {
                  window.location.href = '/admin';
                }
              </script>
            </body>
          </html>
        `);
      }

      // Exchange code for tokens
      const tokens = await oauthManager.exchangeCodeForTokens(code);
      
      // Store tokens in session
      await oauthManager.storeTokens(req.session, tokens);

      // Send success response to popup window
      res.send(`
        <html>
          <head><title>Google Photos Authentication</title></head>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({
                  type: 'google-photos-auth',
                  success: true,
                  data: { authenticated: true }
                }, '*');
                window.close();
              } else {
                window.location.href = '/admin';
              }
            </script>
          </body>
        </html>
      `);
    } catch (error) {
      console.error('OAuth callback error:', error);
      res.send(`
        <html>
          <head><title>Google Photos Authentication</title></head>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({
                  type: 'google-photos-auth',
                  success: false,
                  error: 'Authentication failed: ${error.message}'
                }, '*');
                window.close();
              } else {
                window.location.href = '/admin';
              }
            </script>
          </body>
        </html>
      `);
    }
  }),


  // Revoke access and logout
  revokeAccess: asyncHandler(async (req, res) => {
    try {
      const tokens = oauthManager.getStoredTokens(req.session);
      
      if (tokens && tokens.access_token) {
        await oauthManager.revokeTokens(tokens.access_token);
      }
      
      // Clear session data
      oauthManager.clearStoredTokens(req.session);
      
      res.json({
        success: true,
        data: {
          message: 'Google Photos access revoked successfully'
        }
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      res.status(500).json({
        success: false,
        error: {
          code: 'REVOKE_FAILED',
          message: 'Failed to revoke Google Photos access',
          details: error.message
        }
      });
    }
  }),

  // Create Google Photos Picker session
  createPickerSession: asyncHandler(async (req, res) => {
    try {
      const tokens = oauthManager.getStoredTokens(req.session);
      
      if (!tokens || !tokens.access_token || oauthManager.isTokenExpired(tokens)) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'NOT_AUTHENTICATED',
            message: 'User not authenticated with Google Photos'
          }
        });
      }

      const { destinationPath } = req.body;
      
      if (!destinationPath) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_DESTINATION',
            message: 'Destination path is required'
          }
        });
      }

      // Create picker session using Google Photos Picker API
      const sessionData = await oauthManager.createPickerSession(tokens.access_token, destinationPath);

      res.json({
        success: true,
        sessionId: sessionData.sessionId,
        sessionUrl: sessionData.pickerUri,
        pollingConfig: sessionData.pollingConfig
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Picker session creation error:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'SESSION_CREATION_FAILED',
          message: 'Failed to create Google Photos picker session',
          details: error.message
        }
      });
    }
  }),

  // Get Google Photos Picker session status
  getPickerSession: asyncHandler(async (req, res) => {
    try {
      const tokens = oauthManager.getStoredTokens(req.session);
      
      if (!tokens || !tokens.access_token || oauthManager.isTokenExpired(tokens)) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'NOT_AUTHENTICATED',
            message: 'User not authenticated with Google Photos'
          }
        });
      }

      const { sessionId } = req.params;
      
      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_SESSION_ID',
            message: 'Session ID is required'
          }
        });
      }

      // Get session status using Google Photos Picker API
      const sessionData = await oauthManager.getPickerSession(tokens.access_token, sessionId);

      res.json({
        success: true,
        sessionId: sessionData.id,
        mediaItemsSet: sessionData.mediaItemsSet,
        mediaItems: sessionData.mediaItems || [],
        pollingConfig: sessionData.pollingConfig
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Get picker session error:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'SESSION_GET_FAILED',
          message: 'Failed to get Google Photos picker session',
          details: error.message
        }
      });
    }
  }),

  // Get media items from Google Photos Picker session
  getSessionMediaItems: asyncHandler(async (req, res) => {
    try {
      const tokens = oauthManager.getStoredTokens(req.session);
      
      if (!tokens || !tokens.access_token || oauthManager.isTokenExpired(tokens)) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'NOT_AUTHENTICATED',
            message: 'User not authenticated with Google Photos'
          }
        });
      }

      const { sessionId } = req.params;
      
      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_SESSION_ID',
            message: 'Session ID is required'
          }
        });
      }

      // Get media items from the session using Google Photos Picker API
      const mediaItems = await oauthManager.getSessionMediaItems(tokens.access_token, sessionId);

      res.json({
        success: true,
        sessionId: sessionId,
        mediaItems: mediaItems
      });
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Get session media items error:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'MEDIA_ITEMS_GET_FAILED',
          message: 'Failed to get session media items',
          details: error.message
        }
      });
    }
  }),

  // Proxy endpoint for Google Photos thumbnails
  proxyThumbnail: asyncHandler(async (req, res) => {
    try {
      const tokens = oauthManager.getStoredTokens(req.session);
      
      if (!tokens || !tokens.access_token || oauthManager.isTokenExpired(tokens)) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'NOT_AUTHENTICATED',
            message: 'User not authenticated with Google Photos'
          }
        });
      }

      const { url } = req.query;
      
      if (!url) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_URL',
            message: 'Image URL is required'
          }
        });
      }

      // Fetch image with authentication
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`
        }
      });

      if (!response.ok) {
        console.error('Failed to fetch thumbnail:', response.status, response.statusText);
        return res.status(response.status).json({
          success: false,
          error: {
            code: 'THUMBNAIL_FETCH_FAILED',
            message: 'Failed to fetch thumbnail from Google Photos'
          }
        });
      }

      // Get content type and image data
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const imageBuffer = await response.arrayBuffer();

      // Set appropriate headers and send image
      res.set({
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
        'Content-Length': imageBuffer.byteLength
      });

      res.send(Buffer.from(imageBuffer));
    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('Thumbnail proxy error:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'PROXY_ERROR',
          message: 'Failed to proxy thumbnail request',
          details: error.message
        }
      });
    }
  }),

  // Start background import job
  importPhotos: asyncHandler(async (req, res) => {
    try {
      const tokens = oauthManager.getStoredTokens(req.session);
      
      if (!tokens || !tokens.access_token || oauthManager.isTokenExpired(tokens)) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'NOT_AUTHENTICATED',
            message: 'User not authenticated with Google Photos'
          }
        });
      }

      const { mediaItems, destinationPath } = req.body;
      
      if (!mediaItems || !Array.isArray(mediaItems) || mediaItems.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_MEDIA_ITEMS',
            message: 'Media items are required'
          }
        });
      }

      if (!destinationPath) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_DESTINATION',
            message: 'Destination path is required'
          }
        });
      }

      console.log('🔧 [DEBUG] Starting background import job for', mediaItems.length, 'photos to', destinationPath);

      // Create background job
      const jobId = jobManager.createJob('google-photos-import', {
        mediaItems,
        destinationPath,
        accessToken: tokens.access_token
      }, req.session.id || 'anonymous');

      // Return immediately with job ID
      res.json({
        success: true,
        data: {
          jobId,
          message: `Started importing ${mediaItems.length} photos to ${destinationPath.split('/').pop()} in the background`,
          mediaCount: mediaItems.length,
          destinationPath
        }
      });

    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('❌ [DEBUG] Import photos error:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'IMPORT_FAILED',
          message: 'Failed to start import job',
          details: error.message
        }
      });
    }
  }),

  // Get job status
  getJobStatus: asyncHandler(async (req, res) => {
    try {
      const { jobId } = req.params;
      
      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_JOB_ID',
            message: 'Job ID is required'
          }
        });
      }

      const jobStatus = jobManager.getJobStatus(jobId);
      
      if (!jobStatus) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found'
          }
        });
      }

      res.json({
        success: true,
        data: jobStatus
      });

    } catch (error) {
      if (passClientError(res, error)) return;
      console.error('❌ [DEBUG] Get job status error:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'JOB_STATUS_ERROR',
          message: 'Failed to get job status',
          details: error.message
        }
      });
    }
  })
};

module.exports = googlePhotosController;
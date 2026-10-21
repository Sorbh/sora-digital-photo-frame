console.log('🔧 [DEBUG] GooglePhotosSync.js file loaded successfully');

class GooglePhotosSync {
  constructor() {
    console.log('🔧 [DEBUG] GooglePhotosSync constructor called');
    this.isAuthenticated = false;
    this.userInfo = null;
    this.authenticationInProgress = false;
    this.justAuthenticated = false;
    this.callbackReceived = false; // Flag to prevent race condition with popup close detection
    this.init();
  }

  init() {
    this.checkAuthStatus('init');
    this.bindEvents();
    this.setupMessageListener();
  }

  bindEvents() {
    console.log('🔧 [DEBUG] bindEvents() called');
    const googlePhotosBtn = document.getElementById('googlePhotosBtn');
    if (googlePhotosBtn) {
      console.log('🔧 [DEBUG] Google Photos button found, adding click listener');
      googlePhotosBtn.addEventListener('click', () => {
        console.log('🔧 [DEBUG] Google Photos button clicked!');
        this.handleGooglePhotosAction();
      });
    } else {
      console.error('❌ [DEBUG] Google Photos button not found!');
    }
  }

  setupMessageListener() {
    // Listen for messages from OAuth popup
    window.addEventListener('message', async (event) => {
      if (event.data.type === 'google-photos-auth') {
        await this.handleAuthCallback(event.data);
      }
    });
  }

  async checkAuthStatus(caller = 'unknown') {
    try {
      console.log('checkAuthStatus called by:', caller, 'justAuthenticated:', this.justAuthenticated); // Debug log

      // If we just authenticated successfully, don't override the state for 5 seconds
      if (this.justAuthenticated && caller !== 'handleAuthCallback') {
        console.log('Skipping auth check - just authenticated successfully');
        return;
      }

      const response = await fetch('/api/admin/google-photos/status');

      // Check for session expiration
      if (response.status === 401) {
        try {
          const errorData = await response.json();
          if (errorData.code === 'SESSION_EXPIRED' || errorData.code === 'AUTH_REQUIRED') {
            this.handleSessionExpired();
            return;
          }
        } catch (e) {
          this.handleSessionExpired();
          return;
        }
      }

      const result = await response.json();

      console.log('Auth status check result:', result); // Debug log

      if (result.success) {
        this.isAuthenticated = result.data.authenticated;
        this.userInfo = result.data.userInfo;
        console.log('Updated auth state:', { authenticated: this.isAuthenticated, userInfo: this.userInfo }); // Debug log
        this.updateButtonState();
      }
    } catch (error) {
      console.error('Failed to check Google Photos auth status:', error);
    }
  }

  // Handle session expiration for Google Photos
  handleSessionExpired() {
    this.showError('Session expired. Redirecting to login...');
    setTimeout(() => {
      window.location.href = '/login?expired=true';
    }, 2000);
  }

  updateButtonState() {
    const googlePhotosBtn = document.getElementById('googlePhotosBtn');
    if (!googlePhotosBtn) return;

    console.log('Updating button state:', { authenticated: this.isAuthenticated, userInfo: this.userInfo, justAuthenticated: this.justAuthenticated }); // Debug log

    if (this.isAuthenticated && this.userInfo) {
      console.log('Setting authenticated state'); // Debug log
      googlePhotosBtn.title = `Connected to Google Photos (${this.userInfo.email})`;
      googlePhotosBtn.classList.add('authenticated');
      googlePhotosBtn.innerHTML = '<span class="material-symbols-outlined">check_circle</span><span class="tb-label">Google Photos</span>';
    } else if (!this.justAuthenticated) {
      // Only set to unauthenticated if we haven't just authenticated
      console.log('Setting unauthenticated state'); // Debug log
      googlePhotosBtn.title = 'Connect to Google Photos';
      googlePhotosBtn.classList.remove('authenticated');
      googlePhotosBtn.innerHTML = '<span class="material-symbols-outlined">add_photo_alternate</span><span class="tb-label">Google Photos</span>';
    } else {
      console.log('Preserving button state - just authenticated'); // Debug log
    }
  }

  handleGooglePhotosAction() {
    if (!this.isAuthenticated) {
      this.startAuthentication();
    } else {
      this.showMessage('Successfully connected to Google Photos!');
    }
  }

  async startAuthentication() {
    try {
      console.log('🔧 [DEBUG] startAuthentication() called');
      this.authenticationInProgress = true; // Set flag to prevent race conditions
      this.callbackReceived = false; // Reset callback flag for new authentication attempt

      // Show loading state
      const googlePhotosBtn = document.getElementById('googlePhotosBtn');
      if (googlePhotosBtn) {
        googlePhotosBtn.disabled = true;
        googlePhotosBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_empty</span><span class="tb-label">Connecting</span>';
        console.log('🔧 [DEBUG] Button set to loading state');
      }

      const redirectUri = window.location.origin + '/api/admin/google-photos/callback';
      console.log('🔧 [DEBUG] Making auth request with redirectUri:', redirectUri);

      const response = await fetch('/api/admin/google-photos/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          redirectUri: redirectUri
        })
      });

      console.log('🔧 [DEBUG] Auth response status:', response.status);
      const result = await response.json();
      console.log('🔧 [DEBUG] Auth response result:', result);

      if (result.success) {
        console.log('🔧 [DEBUG] Opening OAuth popup with URL:', result.data.authUrl);

        // Open OAuth popup
        this.authPopup = window.open(
          result.data.authUrl,
          'googlePhotosAuth',
          'width=500,height=600,scrollbars=yes,resizable=yes'
        );

        // Focus the popup
        if (this.authPopup) {
          this.authPopup.focus();
          console.log('🔧 [DEBUG] Popup opened and focused successfully');
        } else {
          console.error('❌ [DEBUG] Failed to open popup - popup blocker?');
        }

        // Listen for popup close without success message
        const checkClosed = setInterval(async () => {
          if (this.authPopup && this.authPopup.closed) {
            clearInterval(checkClosed);
            // Only trigger cancellation if no callback was received
            if (!this.callbackReceived) {
              console.log('🔧 [DEBUG] Popup closed without callback - assuming user cancelled');
              await this.handleAuthCallback({ success: false, error: 'Authentication cancelled by user' });
            } else {
              console.log('🔧 [DEBUG] Popup closed after successful callback');
            }
          }
        }, 1000);
      } else {
        console.error('❌ [DEBUG] Auth request failed:', result.error);
        this.showError('Failed to start authentication: ' + result.error.message);
        this.resetButtonState();
        this.authenticationInProgress = false;
      }
    } catch (error) {
      console.error('❌ [DEBUG] Authentication error:', error);
      this.showError('Failed to start Google Photos authentication');
      this.resetButtonState();
      this.authenticationInProgress = false;
    }
  }

  async handleAuthCallback(data) {
    console.log('🔧 [DEBUG] handleAuthCallback called with data:', data);

    // Set flag to prevent race condition
    this.callbackReceived = true;

    if (this.authPopup && !this.authPopup.closed) {
      this.authPopup.close();
      console.log('🔧 [DEBUG] Popup closed');
    }

    if (data.success) {
      console.log('🔧 [DEBUG] Authentication successful');
      this.isAuthenticated = true;
      this.justAuthenticated = true;

      // Set a timer to clear the justAuthenticated flag after 5 seconds
      setTimeout(() => {
        this.justAuthenticated = false;
        console.log('Cleared justAuthenticated flag');
      }, 5000);

      // Fetch fresh user info before updating button state
      await this.checkAuthStatus('handleAuthCallback');
      this.showMessage('Successfully connected to Google Photos!');

      // Refresh the admin page to show the "Import from Google Photos" button
      if (window.photoFrameAdmin && window.photoFrameAdmin.loadFolderContents) {
        console.log('🔧 [DEBUG] Refreshing folder contents after authentication');
        window.photoFrameAdmin.loadFolderContents();
      }
    } else {
      this.isAuthenticated = false;
      this.userInfo = null;
      this.justAuthenticated = false;
      this.resetButtonState();
      if (data.error !== 'Authentication cancelled by user') {
        this.showError(data.error || 'Authentication failed');
      }
    }

    // Clear authentication in progress flag
    this.authenticationInProgress = false;
  }


  resetButtonState() {
    const googlePhotosBtn = document.getElementById('googlePhotosBtn');
    if (googlePhotosBtn) {
      googlePhotosBtn.disabled = false;
      this.updateButtonState();
    }
  }

  async logout() {
    try {
      const response = await fetch('/api/admin/google-photos/auth', {
        method: 'DELETE'
      });

      const result = await response.json();

      if (result.success) {
        this.isAuthenticated = false;
        this.userInfo = null;
        this.updateButtonState();
        this.showMessage('Disconnected from Google Photos');
      } else {
        this.showError('Failed to disconnect: ' + result.error.message);
      }
    } catch (error) {
      console.error('Logout error:', error);
      this.showError('Failed to disconnect from Google Photos');
    }
  }

  showError(message) {
    // Use existing toast system if available, otherwise console log
    if (window.showToast) {
      window.showToast(message, 'error');
    } else {
      console.error('Google Photos Error:', message);
    }
  }

  showMessage(message) {
    // Use existing toast system if available, otherwise console log
    if (window.showToast) {
      window.showToast(message, 'info');
    } else {
      console.log('Google Photos Message:', message);
    }
  }

  openGooglePhotosModal(currentPath) {
    console.log('🔧 [DEBUG] openGooglePhotosModal called with path:', currentPath);

    if (!this.isAuthenticated) {
      this.showError('Please connect to Google Photos first');
      return;
    }

    this.currentImportPath = currentPath;
    this.showGooglePhotosModal();
    this.createPickerSession();
  }

  showGooglePhotosModal() {
    const modal = document.getElementById('googlePhotosModal');
    if (modal) {
      modal.classList.remove('hidden');
      this.resetModalStates();
      document.getElementById('sessionLoadingState').classList.remove('hidden');
    }
  }

  hideGooglePhotosModal() {
    const modal = document.getElementById('googlePhotosModal');
    if (modal) {
      modal.classList.add('hidden');
      this.currentSessionUrl = null;
    }
  }

  resetModalStates() {
    // Hide standard modal states if they exist
    const loadingState = document.getElementById('sessionLoadingState');
    const readyState = document.getElementById('sessionReadyState');
    const errorState = document.getElementById('sessionErrorState');

    if (loadingState) loadingState.classList.add('hidden');
    if (readyState) readyState.classList.add('hidden');
    if (errorState) errorState.classList.add('hidden');

    // Remove any dynamically created states
    const dynamicStates = [
      'sessionPollingState',
      'sessionCompleteState',
      'mediaItemsLoadingState',
      'importingState'
    ];

    dynamicStates.forEach(stateId => {
      const element = document.getElementById(stateId);
      if (element) {
        element.remove();
      }
    });
  }

  async createPickerSession() {
    try {
      console.log('🔧 [DEBUG] Creating Google Photos picker session...');

      const response = await fetch('/api/admin/google-photos/picker-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          destinationPath: this.currentImportPath
        })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        console.log('🔧 [DEBUG] Session created successfully:', data);
        console.log('🔧 [DEBUG] Session ID from response:', data.sessionId);
        console.log('🔧 [DEBUG] Session URL from response:', data.sessionUrl);
        console.log('🔧 [DEBUG] Polling config from response:', data.pollingConfig);

        // Store session data with parsed polling config
        this.currentSessionData = {
          id: data.sessionId,
          url: data.sessionUrl,
          pollingConfig: this.parsePollingConfig(data.pollingConfig)
        };

        console.log('🔧 [DEBUG] Stored session data:', this.currentSessionData);

        this.currentSessionUrl = data.sessionUrl;
        this.showSessionReady();
      } else {
        console.error('❌ [DEBUG] Failed to create session:', data.error);
        this.showSessionError(data.error || 'Failed to create picker session');
      }
    } catch (error) {
      console.error('❌ [DEBUG] Error creating picker session:', error);
      this.showSessionError('Failed to create picker session');
    }
  }

  showSessionReady() {
    this.resetModalStates();
    document.getElementById('sessionReadyState').classList.remove('hidden');
  }

  showSessionError(errorMessage) {
    this.resetModalStates();
    document.getElementById('sessionErrorState').classList.remove('hidden');
    document.getElementById('sessionErrorMessage').textContent = errorMessage;
  }

  openPickerSession() {
    if (this.currentSessionUrl && this.currentSessionData) {
      // Open the picker in a new tab
      window.open(this.currentSessionUrl, '_blank');

      // Start polling and timer
      this.startSessionPolling();
      this.showPollingState();
    }
  }

  showPollingState() {
    this.resetModalStates();

    // Show polling state with timer
    const pollingState = document.createElement('div');
    pollingState.id = 'sessionPollingState';
    pollingState.className = 'session-state';
    pollingState.innerHTML = `
      <div class="session-icon">
        <span class="material-icons">access_time</span>
      </div>
      <p>Waiting for photo selection...</p>
      <div class="session-timer">
        <span id="sessionTimer">--:--</span>
      </div>
      <small>Select photos in the Google Photos tab and confirm your selection.</small>
    `;

    // Replace the ready state with polling state
    const readyState = document.getElementById('sessionReadyState');
    readyState.parentNode.insertBefore(pollingState, readyState);
    readyState.remove();
  }

  startSessionPolling() {
    const { pollInterval, timeoutIn } = this.currentSessionData.pollingConfig;

    console.log('🔧 [DEBUG] Starting session polling:', { pollInterval, timeoutIn });

    // Start timeout timer
    this.sessionStartTime = Date.now();
    this.sessionTimeoutMs = timeoutIn;
    this.startSessionTimer();

    // Start polling
    this.pollingInterval = setInterval(() => {
      this.pollSession();
    }, pollInterval);

    // Set overall timeout
    this.sessionTimeout = setTimeout(() => {
      this.handleSessionTimeout();
    }, timeoutIn);
  }

  startSessionTimer() {
    this.timerInterval = setInterval(() => {
      const elapsed = Date.now() - this.sessionStartTime;
      const remaining = Math.max(0, this.sessionTimeoutMs - elapsed);

      if (remaining === 0) {
        clearInterval(this.timerInterval);
        return;
      }

      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      const timeString = `${minutes}:${seconds.toString().padStart(2, '0')}`;

      const timerElement = document.getElementById('sessionTimer');
      if (timerElement) {
        timerElement.textContent = timeString;
      }
    }, 1000);
  }

  async pollSession() {
    try {
      console.log('🔧 [DEBUG] Polling session:', this.currentSessionData.id);

      const response = await fetch(`/api/admin/google-photos/session/${this.currentSessionData.id}`);
      const data = await response.json();

      if (response.ok && data.success) {
        console.log('🔧 [DEBUG] Session poll result:', data);

        if (data.mediaItemsSet) {
          // User has selected photos, stop polling and fetch media items
          console.log('🔧 [DEBUG] Media items set detected, fetching selected photos...');
          this.clearSessionTimers();
          this.fetchSessionMediaItems();
        }
      } else {
        console.warn('⚠️ [DEBUG] Session poll failed:', data.error);
      }
    } catch (error) {
      console.error('❌ [DEBUG] Error polling session:', error);
    }
  }

  async fetchSessionMediaItems() {
    try {
      console.log('🔧 [DEBUG] Fetching media items for session:', this.currentSessionData.id);

      // Show loading state for media items
      this.showMediaItemsLoading();

      const response = await fetch(`/api/admin/google-photos/session/${this.currentSessionData.id}/media-items`);
      const data = await response.json();

      if (response.ok && data.success) {
        console.log('🔧 [DEBUG] Media items fetched successfully:', data.mediaItems);
        console.log('🔧 [DEBUG] Number of media items:', data.mediaItems?.length || 0);

        if (data.mediaItems && data.mediaItems.length > 0) {
          console.log('🔧 [DEBUG] First media item:', data.mediaItems[0]);
          console.log('🔧 [DEBUG] First media item keys:', Object.keys(data.mediaItems[0]));
        }

        this.handleSessionComplete(data.mediaItems);
      } else {
        console.error('❌ [DEBUG] Failed to fetch media items:', data.error);
        this.showSessionError('Failed to fetch selected photos');
      }
    } catch (error) {
      console.error('❌ [DEBUG] Error fetching media items:', error);
      this.showSessionError('Failed to fetch selected photos');
    }
  }

  showMediaItemsLoading() {
    this.resetModalStates();

    const loadingState = document.createElement('div');
    loadingState.id = 'mediaItemsLoadingState';
    loadingState.className = 'session-state';
    loadingState.innerHTML = `
      <div class="session-loader">
        <div class="spinner"></div>
      </div>
      <p>Loading selected photos...</p>
    `;

    const modalContent = document.querySelector('.google-photos-content');
    if (modalContent) {
      modalContent.appendChild(loadingState);
    } else {
      console.error('❌ [DEBUG] Modal content not found for media items loading state');
    }
  }

  handleSessionComplete(mediaItems) {
    console.log('🔧 [DEBUG] Session completed with media items:', mediaItems);

    // Clear timers and intervals
    this.clearSessionTimers();

    // Show completion state with thumbnails
    this.showSessionComplete(mediaItems);
  }

  handleSessionTimeout() {
    console.log('🔧 [DEBUG] Session timed out');

    // Clear timers and intervals
    this.clearSessionTimers();

    // Close modal and show timeout message
    this.hideGooglePhotosModal();
    this.showMessage('Google Photos session timed out. Please try again.');
  }

  clearSessionTimers() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
      this.sessionTimeout = null;
    }

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  showSessionComplete(mediaItems) {
    this.resetModalStates();

    const completeState = document.createElement('div');
    completeState.id = 'sessionCompleteState';
    completeState.className = 'session-state';

    // Create thumbnails HTML with horizontal limit and count indicator
    // Calculate how many thumbnails can fit in horizontal space
    // Assuming modal width ~500px, padding 16px, thumbnail 80px + gap 8px = 88px per thumbnail
    const modalWidth = 500 - 32; // Account for modal padding
    const thumbnailWidth = 80 + 8; // thumbnail + gap
    const maxThumbnails = Math.floor(modalWidth / thumbnailWidth);

    const displayItems = mediaItems.slice(0, maxThumbnails);
    const remainingCount = Math.max(0, mediaItems.length - maxThumbnails);

    const thumbnailsHtml = displayItems.map((item, index) => {
      console.log('🔧 [DEBUG] Processing media item for thumbnail:', item);

      if (item.mediaFile) {
        console.log('🔧 [DEBUG] Media file structure:', item.mediaFile);
        console.log('🔧 [DEBUG] Media file keys:', Object.keys(item.mediaFile));
      }

      // Get thumbnail URL - handle Google Photos Picker API structure
      let originalUrl = '';

      if (item.baseUrl) {
        // Standard Google Photos Library API format
        originalUrl = `${item.baseUrl}=w150-h150-c`;
      } else if (item.mediaFile && item.mediaFile.baseUrl) {
        // Google Photos Picker API format
        originalUrl = `${item.mediaFile.baseUrl}=w150-h150-c`;
      } else if (item.mediaFile && item.mediaFile.url) {
        // Alternative URL property
        originalUrl = item.mediaFile.url;
      } else if (item.productUrl) {
        originalUrl = item.productUrl;
      } else {
        console.warn('⚠️ [DEBUG] No thumbnail URL found for item:', item);
      }

      // Use proxy endpoint for authenticated access
      let thumbnailUrl;
      if (originalUrl) {
        thumbnailUrl = `/api/admin/google-photos/thumbnail?url=${encodeURIComponent(originalUrl)}`;
      } else {
        thumbnailUrl = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUwIiBoZWlnaHQ9IjE1MCIgdmlld0JveD0iMCAwIDE1MCAxNTAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi0vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxNTAiIGhlaWdodD0iMTUwIiBmaWxsPSIjZjVmNWY1Ii8+CjxwYXRoIGQ9Ik03NSA0MEM2OC4zNzUgNDAgNjMgNDUuMzc1IDYzIDUyVjk4QzYzIDEwNC42MjUgNjguMzc1IDExMCA3NSAxMTBIMTIxQzEyNy42MjUgMTEwIDEzMyAxMDQuNjI1IDEzMyA5OFY1MkMxMzMgNDUuMzc1IDEyNy42MjUgNDAgMTIxIDQwSDc1WiIgZmlsbD0iIzlFOUU5RSIvPgo8L3N2Zz4K';
      }

      // Check if this is the last thumbnail and we have remaining items
      const isLastThumbnail = index === displayItems.length - 1 && remainingCount > 0;

      return `
        <div class="photo-thumbnail" data-media-id="${item.id || index}">
          <img src="${thumbnailUrl}" alt="Selected photo ${index + 1}" loading="lazy" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUwIiBoZWlnaHQ9IjE1MCIgdmlld0JveD0iMCAwIDE1MCAxNTAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi0vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxNTAiIGhlaWdodD0iMTUwIiBmaWxsPSIjZjVmNWY1Ii8+CjxwYXRoIGQ9Ik03NSA0MEM2OC4zNzUgNDAgNjMgNDUuMzc1IDYzIDUyVjk4QzYzIDEwNC42MjUgNjguMzc1IDExMCA3NSAxMTBIMTIxQzEyNy42MjUgMTEwIDEzMyAxMDQuNjI1IDEzMyA5OFY1MkMxMzMgNDUuMzc1IDEyNy42MjUgNDAgMTIxIDQwSDc1WiIgZmlsbD0iIzlFOUU5RSIvPgo8L3N2Zz4K'">
          ${isLastThumbnail ? `
            <div class="thumbnail-count-overlay">
              <div class="count-text">+${remainingCount}<br>more</div>
            </div>
          ` : `
            <div class="thumbnail-overlay">
              <div class="thumbnail-info">
                <span class="material-icons">image</span>
              </div>
            </div>
          `}
        </div>
      `;
    }).join('');

    completeState.innerHTML = `
      <div class="session-icon">
        <span class="material-icons">check_circle</span>
      </div>
      <p>Photos selected successfully!</p>
      <small>${mediaItems.length} photo(s) ready to import</small>
      
      <div class="selected-photos-container">
        <div class="photos-thumbnails">
          ${thumbnailsHtml}
        </div>
      </div>
      
      <div class="import-actions">
        <button id="importToFolderBtn" class="btn-primary">
          <span class="material-icons">folder</span>
          Import to ${this.currentImportPath.split('/').pop()}
        </button>
      </div>
    `;

    // Store media items for download
    this.selectedMediaItems = mediaItems;

    // Add to modal content
    const modalContent = document.querySelector('.google-photos-content');
    if (modalContent) {
      modalContent.appendChild(completeState);

      // Add event listener for import button
      const importBtn = document.getElementById('importToFolderBtn');

      if (importBtn) {
        importBtn.addEventListener('click', () => {
          this.importPhotosToFolder();
        });
      }
    } else {
      console.error('❌ [DEBUG] Modal content not found for session complete state');
    }
  }

  // Parse Google's duration strings (e.g., "5s", "300.5s") to milliseconds
  parsePollingConfig(pollingConfig) {
    console.log('🔧 [DEBUG] Frontend parsing polling config:', pollingConfig);

    if (!pollingConfig) {
      return {
        pollInterval: 5000,   // Default 5 seconds
        timeoutIn: 300000     // Default 5 minutes
      };
    }

    const parseDuration = (durationStr) => {
      // If already a number, return as is (backend already parsed)
      if (typeof durationStr === 'number') {
        return durationStr;
      }

      // If string, parse it
      if (typeof durationStr === 'string') {
        const match = durationStr.match(/^(\d+(?:\.\d+)?)s$/);
        if (match) {
          return Math.round(parseFloat(match[1]) * 1000); // Convert to milliseconds
        }
      }

      return null;
    };

    const pollInterval = parseDuration(pollingConfig.pollInterval) || 5000;   // Default 5 seconds
    const timeoutIn = parseDuration(pollingConfig.timeoutIn) || 300000;       // Default 5 minutes

    const result = { pollInterval, timeoutIn };
    console.log('🔧 [DEBUG] Frontend parsed polling config result:', result);

    return result;
  }


  async importPhotosToFolder() {
    if (!this.selectedMediaItems || this.selectedMediaItems.length === 0) {
      this.showError('No photos selected for import');
      return;
    }

    console.log('🔧 [DEBUG] Starting background import of', this.selectedMediaItems.length, 'photos to', this.currentImportPath);

    try {
      // Show importing state briefly
      this.showImportingState();

      const response = await fetch('/api/admin/google-photos/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          mediaItems: this.selectedMediaItems,
          destinationPath: this.currentImportPath
        })
      });

      console.log('🔧 [DEBUG] Import response status:', response.status);
      console.log('🔧 [DEBUG] Import response headers:', response.headers.get('content-type'));

      const responseText = await response.text();
      console.log('🔧 [DEBUG] Raw response text:', responseText);

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error('❌ [DEBUG] Failed to parse response as JSON:', parseError);
        this.showSessionError('Server returned invalid response');
        return;
      }

      if (response.ok && data.success) {
        console.log('🔧 [DEBUG] Background import job started:', data.data);
        console.log('🔧 [DEBUG] Response data keys:', Object.keys(data.data || {}));
        console.log('🔧 [DEBUG] destinationPath:', data.data?.destinationPath);
        console.log('🔧 [DEBUG] mediaCount:', data.data?.mediaCount);
        console.log('🔧 [DEBUG] jobId:', data.data?.jobId);
        console.log('🔧 [DEBUG] currentImportPath:', this.currentImportPath);

        // Close modal immediately
        this.hideGooglePhotosModal();

        // Show background job message
        const mediaCount = data.data?.mediaCount || this.selectedMediaItems?.length || 0;
        const destinationPath = data.data?.destinationPath || this.currentImportPath || 'folder';
        const jobId = data.data?.jobId;

        const folderName = destinationPath.split('/').pop();
        this.showMessage(`Started importing ${mediaCount} photo${mediaCount !== 1 ? 's' : ''} to ${folderName} in the background. You can continue working while we sync your photos.`);

        // Start monitoring job progress only if we have a valid jobId
        if (jobId) {
          this.checkJobProgress(jobId);
        } else {
          console.warn('⚠️ [DEBUG] No jobId returned, cannot monitor progress');
        }

      } else {
        console.error('❌ [DEBUG] Import job failed to start:', data.error);
        this.showSessionError(data.error?.message || 'Failed to start import job');
      }
    } catch (error) {
      console.error('❌ [DEBUG] Error starting import job:', error);
      this.showSessionError('Failed to start import job');
    }
  }

  // Optional: Check job progress periodically
  async checkJobProgress(jobId) {
    if (!jobId || jobId === 'undefined') {
      console.error('❌ [DEBUG] Invalid jobId for progress checking:', jobId);
      return;
    }

    console.log('🔧 [DEBUG] Starting job progress monitoring for:', jobId);

    const checkInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/admin/google-photos/job/${jobId}`);
        const data = await response.json();

        if (response.ok && data.success) {
          const job = data.data;
          console.log('🔧 [DEBUG] Job progress:', job.progress);

          if (job.status === 'completed') {
            clearInterval(checkInterval);
            const { successCount, failCount } = job.result;
            let message = `Import completed! ${successCount} photo${successCount !== 1 ? 's' : ''} imported successfully`;
            if (failCount > 0) {
              message += ` (${failCount} failed)`;
            }
            this.showMessage(message);

            // Refresh page to show new photos
            setTimeout(() => {
              if (window.location.reload) {
                window.location.reload();
              }
            }, 2000);

          } else if (job.status === 'failed') {
            clearInterval(checkInterval);
            this.showError(`Import failed: ${job.error || 'Unknown error'}`);
          }
        }
      } catch (error) {
        console.warn('⚠️ [DEBUG] Failed to check job progress:', error);
        // Don't clear interval on temporary errors
      }
    }, 3000); // Check every 3 seconds

    // Stop checking after 10 minutes
    setTimeout(() => {
      clearInterval(checkInterval);
    }, 600000);
  }

  showImportingState() {
    this.resetModalStates();

    const importingState = document.createElement('div');
    importingState.id = 'importingState';
    importingState.className = 'session-state';
    importingState.innerHTML = `
      <div class="session-loader">
        <div class="spinner"></div>
      </div>
      <p>Importing photos to your folder...</p>
      <small>This may take a few moments</small>
    `;

    const modalContent = document.querySelector('.google-photos-content');
    if (modalContent) {
      modalContent.appendChild(importingState);
    } else {
      console.error('❌ [DEBUG] Modal content not found for importing state');
    }
  }

  hideGooglePhotosModal() {
    // Clear any timers when modal is closed
    this.clearSessionTimers();

    const modal = document.getElementById('googlePhotosModal');
    if (modal) {
      modal.classList.add('hidden');
      this.currentSessionUrl = null;
      this.currentSessionData = null;
      this.selectedMediaItems = null;

      // Clean up any dynamically created states
      const pollingState = document.getElementById('sessionPollingState');
      const completeState = document.getElementById('sessionCompleteState');
      const loadingState = document.getElementById('mediaItemsLoadingState');
      const importingState = document.getElementById('importingState');
      if (pollingState) pollingState.remove();
      if (completeState) completeState.remove();
      if (loadingState) loadingState.remove();
      if (importingState) importingState.remove();
    }
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.googlePhotosSync = new GooglePhotosSync();
});
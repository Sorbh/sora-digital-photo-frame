/**
 * Folder Selector Widget - Compact folder selector for slideshow page
 */
class FolderSelector {
    constructor(container, options = {}) {
        this.container = container;
        this.folderService = new FolderService();
        this.folderStorage = new FolderStorage();
        
        // Configuration options
        this.options = {
            onFolderChanged: options.onFolderChanged || null,
            showFolderCount: options.showFolderCount !== false,
            autoClose: options.autoClose !== false,
            ...options
        };
        
        // State
        this.isOpen = false;
        this.folders = [];
        this.isLoading = false;
        this.expandedFolders = new Set(); // Track expanded folders
        this.loadedSubfolders = new Map(); // Cache loaded subfolders
        
        this.initializeComponent();
        this.loadFolders();
        this.updateCurrentSelection();
    }

    /**
     * Initialize the component HTML structure
     */
    initializeComponent() {
        this.container.innerHTML = `
            <div class="folder-selector">
                <button class="folder-selector-btn" title="Select folder for slideshow">
                    <span class="material-icons">folder</span>
                    <span class="selected-folder-name">All Folders</span>
                    <span class="material-icons dropdown-arrow">keyboard_arrow_down</span>
                </button>
                
                <div class="folder-dropdown hidden">
                    <div class="folder-dropdown-header">
                        <span>Select Folder</span>
                        <button class="close-dropdown">
                            <span class="material-icons">close</span>
                        </button>
                    </div>
                    
                    <div class="folder-options">
                        <div class="folder-option all-folders" data-path="">
                            <div class="folder-option-content">
                                <div class="folder-spacer"></div>
                                <span class="material-icons folder-icon">photo_library</span>
                                <div class="folder-details">
                                    <div class="folder-name">All Folders</div>
                                    <div class="folder-count">All images</div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="folder-list">
                            <!-- Folders will be loaded here -->
                        </div>
                    </div>
                    
                    <div class="folder-loading">
                        <div class="loading-spinner"></div>
                        <span>Loading folders...</span>
                    </div>
                    
                    <div class="folder-error hidden">
                        <span class="material-icons">error</span>
                        <span class="error-text">Failed to load folders</span>
                        <button class="retry-btn">Retry</button>
                    </div>
                </div>
            </div>
        `;

        this.setupEventListeners();
        this.addStyles();
    }

    /**
     * Set up event listeners
     */
    setupEventListeners() {
        // Toggle dropdown
        const selectorBtn = this.container.querySelector('.folder-selector-btn');
        selectorBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.toggleDropdown();
        });

        // Close dropdown
        const closeBtn = this.container.querySelector('.close-dropdown');
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.closeDropdown();
        });

        // Folder selection and expansion
        this.container.addEventListener('click', (e) => {
            // Handle expand/collapse button
            const expandBtn = e.target.closest('.expand-btn');
            if (expandBtn) {
                e.preventDefault();
                e.stopPropagation();
                const folderOption = expandBtn.closest('.folder-option');
                const folderPath = folderOption.dataset.path;
                this.toggleFolderExpansion(folderPath);
                return;
            }

            // Handle folder selection
            const folderOption = e.target.closest('.folder-option');
            if (folderOption && !e.target.closest('.close-dropdown')) {
                e.preventDefault();
                const folderPath = folderOption.dataset.path;
                const folderName = folderOption.querySelector('.folder-name')?.textContent || '';
                this.selectFolder(folderPath, folderName);
            }

            // Retry button
            const retryBtn = e.target.closest('.retry-btn');
            if (retryBtn) {
                e.preventDefault();
                this.loadFolders();
            }
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!this.container.contains(e.target)) {
                this.closeDropdown();
            }
        });

        // Close dropdown on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.closeDropdown();
            }
        });
    }

    /**
     * Add component styles
     */
    addStyles() {
        if (document.getElementById('folder-selector-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'folder-selector-styles';
        styles.textContent = `
            .folder-selector {
                position: relative;
                display: inline-flex;
            }

            .folder-selector-btn {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                height: 44px;
                padding: 0 12px 0 14px;
                border: 0;
                border-radius: var(--shape-sm);
                background: transparent;
                color: #fff4ef;
                font: 550 0.875rem/1 var(--font-sans, sans-serif);
                letter-spacing: 0.01em;
                cursor: pointer;
                transition: background-color 0.18s ease;
            }

            .folder-selector-btn:hover,
            .open .folder-selector-btn {
                background: rgba(255, 255, 255, 0.09);
            }

            .folder-selector-btn .material-icons {
                font-size: 20px;
            }

            .selected-folder-name {
                max-width: 11rem;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .dropdown-arrow {
                opacity: 0.6;
                transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
            }

            .open .dropdown-arrow {
                transform: rotate(180deg);
            }

            .folder-dropdown {
                position: absolute;
                bottom: calc(100% + 18px);
                left: 50%;
                width: 21rem;
                max-width: calc(100vw - 2rem);
                padding: 6px;
                transform: translateX(-50%);
                transform-origin: 50% 100%;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: var(--shape-lg);
                background: rgba(22, 20, 17, 0.86);
                backdrop-filter: blur(28px) saturate(1.4);
                -webkit-backdrop-filter: blur(28px) saturate(1.4);
                box-shadow: 0 30px 60px -20px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(0, 0, 0, 0.3);
                color: #fff4ef;
                z-index: 40;
                animation: folder-pop 0.28s cubic-bezier(0.22, 1, 0.36, 1);
            }

            @keyframes folder-pop {
                from { opacity: 0; transform: translateX(-50%) translateY(8px) scale(0.97); }
                to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
            }

            .folder-dropdown.hidden {
                display: none;
            }

            .folder-dropdown-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 10px 8px 14px;
                font: 500 0.6875rem/1 var(--font-sans, sans-serif);
                letter-spacing: 0.14em;
                text-transform: uppercase;
                color: rgba(255, 244, 239, 0.55);
            }

            .close-dropdown {
                display: grid;
                place-items: center;
                width: 28px;
                height: 28px;
                border: 0;
                border-radius: 50%;
                background: transparent;
                color: inherit;
                cursor: pointer;
            }

            .close-dropdown:hover {
                background: rgba(255, 255, 255, 0.08);
                color: #fff4ef;
            }

            .close-dropdown .material-icons {
                font-size: 18px;
            }

            .folder-options {
                max-height: min(56vh, 30rem);
                overflow-y: auto;
                overscroll-behavior: contain;
            }

            .folder-option {
                cursor: pointer;
            }

            .folder-option-content {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 7px 10px 7px 8px;
                border-radius: var(--shape-sm);
                transition: background-color 0.15s ease;
            }

            .folder-option:hover .folder-option-content {
                background: rgba(255, 255, 255, 0.06);
            }

            .folder-option.selected .folder-option-content {
                background: rgba(255, 92, 141, 0.16);
                box-shadow: inset 0 0 0 1px rgba(255, 92, 141, 0.35);
            }

            .folder-option.all-folders {
                margin-bottom: 4px;
                padding-bottom: 4px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            }

            .folder-spacer {
                width: 0;
                flex-shrink: 0;
            }

            .expand-btn {
                display: grid;
                place-items: center;
                width: 22px;
                height: 22px;
                flex-shrink: 0;
                margin-right: -6px;
                border: 0;
                border-radius: var(--shape-xs);
                background: transparent;
                color: rgba(255, 244, 239, 0.6);
                cursor: pointer;
            }

            .expand-btn:hover {
                background: rgba(255, 255, 255, 0.1);
                color: #fff4ef;
            }

            .expand-btn .material-icons {
                font-size: 18px;
            }

            .folder-option .folder-icon,
            .folder-option .folder-thumb {
                width: 44px;
                height: 44px;
                flex-shrink: 0;
                border-radius: var(--shape-xs);
            }

            .folder-option .folder-icon {
                display: grid;
                place-items: center;
                background: rgba(255, 255, 255, 0.06);
                color: rgba(255, 244, 239, 0.7);
                font-size: 22px;
            }

            .folder-option.all-folders .folder-icon {
                background: linear-gradient(135deg, rgba(255, 92, 141, 0.9), rgba(196, 43, 110, 0.75));
                color: #fff;
            }

            .folder-option .folder-thumb {
                object-fit: cover;
                box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
            }

            .folder-details {
                display: grid;
                gap: 3px;
                min-width: 0;
            }

            .folder-option .folder-name {
                overflow: hidden;
                font: 500 0.95rem/1.2 var(--font-sans, sans-serif);
                white-space: nowrap;
                text-overflow: ellipsis;
            }

            .folder-count {
                font: 400 0.6875rem/1 var(--font-sans, sans-serif);
                letter-spacing: 0.04em;
                color: rgba(255, 244, 239, 0.5);
            }

            .folder-loading {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 12px;
                padding: 20px;
                font-size: 0.875rem;
                color: rgba(255, 244, 239, 0.6);
            }

            .loading-spinner {
                width: 16px;
                height: 16px;
                border: 2px solid rgba(255, 255, 255, 0.15);
                border-top-color: #ff5c8d;
                border-radius: 50%;
                animation: folder-spin 0.9s linear infinite;
            }

            @keyframes folder-spin {
                to { transform: rotate(360deg); }
            }

            .folder-error {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 10px;
                padding: 20px;
                font-size: 0.875rem;
                color: #ffb3c8;
                text-align: center;
            }

            .folder-error.hidden {
                display: none;
            }

            .retry-btn {
                padding: 7px 14px;
                border: 0;
                border-radius: var(--shape-sm);
                background: #ff5c8d;
                color: #fff;
                font: 600 0.8rem/1 var(--font-sans, sans-serif);
                cursor: pointer;
            }

            /* Phones: icon-only so the dock fits the screen */
            @media (max-width: 600px) {
                .folder-selector-btn {
                    width: 40px;
                    height: 40px;
                    padding: 0;
                    justify-content: center;
                }

                .selected-folder-name,
                .dropdown-arrow {
                    display: none;
                }
            }
        `;
        document.head.appendChild(styles);
    }

    /**
     * Toggle dropdown open/closed
     */
    toggleDropdown() {
        if (this.isOpen) {
            this.closeDropdown();
        } else {
            this.openDropdown();
        }
    }

    /**
     * Open dropdown
     */
    openDropdown() {
        this.isOpen = true;
        this.container.classList.add('open');
        this.container.querySelector('.folder-dropdown').classList.remove('hidden');
        
        // Load folders if not already loaded
        if (this.folders.length === 0 && !this.isLoading) {
            this.loadFolders();
        }
    }

    /**
     * Close dropdown
     */
    closeDropdown() {
        this.isOpen = false;
        this.container.classList.remove('open');
        this.container.querySelector('.folder-dropdown').classList.add('hidden');
    }

    /**
     * Load folders from API
     */
    async loadFolders() {
        if (this.isLoading) return;
        
        this.showLoading(true);
        this.hideError();
        
        try {
            const data = await this.folderService.getFolderStructure();
            this.folders = data.folders || [];
            this.renderFolders();
            this.updateSelectedState();
        } catch (error) {
            console.error('Error loading folders:', error);
            this.showError(error.message);
        } finally {
            this.showLoading(false);
        }
    }

    /**
     * Render folders in dropdown
     */
    renderFolders() {
        const list = this.container.querySelector('.folder-list');
        if (!list) return;

        list.innerHTML = '';
        this.renderFolderLevel(this.folders, list, 0);
    }

    /**
     * Render folders at a specific level with indentation
     * @param {Array} folders - Folders to render
     * @param {Element} container - Container to append to
     * @param {number} level - Nesting level for indentation
     */
    renderFolderLevel(folders, container, level) {
        folders.forEach(folder => {
            const element = document.createElement('div');
            element.className = 'folder-option';
            element.dataset.path = folder.path;
            element.dataset.level = level;
            
            const isExpanded = this.expandedFolders.has(folder.path);
            const hasSubfolders = folder.hasSubfolders;
            const indentPadding = level * 20; // 20px per level
            
            element.innerHTML = `
                <div class="folder-option-content" style="padding-left: ${indentPadding}px;">
                    ${hasSubfolders ? 
                        `<button class="expand-btn" data-expanded="${isExpanded}">
                            <span class="material-icons">${isExpanded ? 'keyboard_arrow_down' : 'keyboard_arrow_right'}</span>
                        </button>` : 
                        `<div class="folder-spacer"></div>`
                    }
                    ${folder.thumbnail
                        ? `<img class="folder-thumb" src="${folder.thumbnail}" alt="">`
                        : `<span class="material-icons folder-icon">folder</span>`}
                    <div class="folder-details">
                        <div class="folder-name"></div>
                        ${this.options.showFolderCount ? `<div class="folder-count">${folder.imageCount} images</div>` : ''}
                    </div>
                </div>
            `;
            element.querySelector('.folder-name').textContent = folder.name;

            container.appendChild(element);
            
            // Render subfolders if expanded
            if (isExpanded && this.loadedSubfolders.has(folder.path)) {
                const subfolders = this.loadedSubfolders.get(folder.path);
                this.renderFolderLevel(subfolders, container, level + 1);
            }
        });
    }

    /**
     * Select a folder
     * @param {string} folderPath - Selected folder path
     * @param {string} folderName - Display name of selected folder
     */
    selectFolder(folderPath, folderName) {
        console.log('🎯 Folder selected:', folderPath, folderName);
        
        // Save selection
        this.folderStorage.saveSelectedFolder(folderPath, folderName);
        
        // Verify it was saved
        const saved = this.folderStorage.getCurrentFolderPath();
        console.log('💾 Saved folder path:', saved);
        
        // Update display
        this.updateCurrentSelection();
        this.updateSelectedState();
        
        // Close dropdown if auto-close is enabled
        if (this.options.autoClose) {
            this.closeDropdown();
        }
        
        // Trigger callback
        if (this.options.onFolderChanged) {
            console.log('🔄 Triggering onFolderChanged callback');
            this.options.onFolderChanged(folderPath, folderName);
        }
    }

    /**
     * Update current selection display
     */
    updateCurrentSelection() {
        const selectedFolder = this.folderStorage.loadSelectedFolder();
        const nameElement = this.container.querySelector('.selected-folder-name');
        
        if (nameElement) {
            nameElement.textContent = selectedFolder ? selectedFolder.name : 'All Folders';
        }
    }

    /**
     * Update visual state to show selected folder
     */
    updateSelectedState() {
        const selectedPath = this.folderStorage.getCurrentFolderPath();
        
        // Remove previous selection
        this.container.querySelectorAll('.folder-option.selected').forEach(el => {
            el.classList.remove('selected');
        });
        
        // Add selection to current folder
        const selectedElement = this.container.querySelector(`[data-path="${selectedPath}"]`);
        if (selectedElement) {
            selectedElement.classList.add('selected');
            
            // Auto-expand parent folders if needed
            this.expandParentFolders(selectedPath);
        }
    }
    
    /**
     * Expand parent folders to show selected nested folder
     * @param {string} folderPath - Path of selected folder
     */
    async expandParentFolders(folderPath) {
        if (!folderPath) return;
        
        const pathParts = folderPath.split('/');
        let currentPath = '';
        
        // Expand each parent folder in the path
        for (let i = 0; i < pathParts.length - 1; i++) {
            currentPath = currentPath ? `${currentPath}/${pathParts[i]}` : pathParts[i];
            
            if (!this.expandedFolders.has(currentPath)) {
                this.expandedFolders.add(currentPath);
                
                // Load subfolders if not already loaded
                if (!this.loadedSubfolders.has(currentPath)) {
                    await this.loadSubfolders(currentPath);
                }
            }
        }
        
        // Re-render to show expanded folders
        this.renderFolders();
    }

    /**
     * Show/hide loading state
     * @param {boolean} show - Whether to show loading
     */
    showLoading(show) {
        this.isLoading = show;
        const loading = this.container.querySelector('.folder-loading');
        const options = this.container.querySelector('.folder-options');
        
        if (loading) {
            loading.style.display = show ? 'flex' : 'none';
        }
        if (options) {
            options.style.display = show ? 'none' : 'block';
        }
    }

    /**
     * Show error message
     * @param {string} message - Error message to display
     */
    showError(message) {
        const error = this.container.querySelector('.folder-error');
        const errorText = this.container.querySelector('.error-text');
        const loading = this.container.querySelector('.folder-loading');
        const options = this.container.querySelector('.folder-options');
        
        if (error) {
            error.classList.remove('hidden');
        }
        if (errorText) {
            errorText.textContent = message;
        }
        if (loading) {
            loading.style.display = 'none';
        }
        if (options) {
            options.style.display = 'none';
        }
    }

    /**
     * Hide error message
     */
    hideError() {
        const error = this.container.querySelector('.folder-error');
        if (error) {
            error.classList.add('hidden');
        }
    }

    /**
     * Get currently selected folder
     * @returns {Object} Current folder selection
     */
    getSelectedFolder() {
        return this.folderStorage.loadSelectedFolder();
    }

    /**
     * Toggle folder expansion
     * @param {string} folderPath - Path of folder to toggle
     */
    async toggleFolderExpansion(folderPath) {
        const isExpanded = this.expandedFolders.has(folderPath);
        
        if (isExpanded) {
            // Collapse folder
            this.expandedFolders.delete(folderPath);
            this.renderFolders();
        } else {
            // Expand folder
            this.expandedFolders.add(folderPath);
            
            // Load subfolders if not already loaded
            if (!this.loadedSubfolders.has(folderPath)) {
                await this.loadSubfolders(folderPath);
            }
            
            this.renderFolders();
        }
    }
    
    /**
     * Load subfolders for a specific folder
     * @param {string} folderPath - Path of folder to load subfolders for
     */
    async loadSubfolders(folderPath) {
        try {
            const data = await this.folderService.getFolderStructure(folderPath);
            const subfolders = data.subfolders || [];
            this.loadedSubfolders.set(folderPath, subfolders);
        } catch (error) {
            console.error('Error loading subfolders:', error);
            // Remove from expanded set if loading failed
            this.expandedFolders.delete(folderPath);
        }
    }
    
    /**
     * Find if a folder path exists in the current folder list
     * @param {string} folderPath - Path to search for
     * @returns {boolean} True if folder exists
     */
    findFolderInList(folderPath) {
        if (!folderPath) return true; // "All Folders" always exists
        
        const searchInFolders = (folders) => {
            for (const folder of folders) {
                if (folder.path === folderPath) return true;
                if (folder.subfolders && searchInFolders(folder.subfolders)) return true;
            }
            return false;
        };
        
        return searchInFolders(this.folders);
    }

    /**
     * Refresh the folder list while preserving current selection
     */
    async refresh() {
        // Save current selection before refresh
        const currentSelection = this.folderStorage.loadSelectedFolder();
        
        this.folders = [];
        this.expandedFolders.clear();
        this.loadedSubfolders.clear();
        
        try {
            // Load folders (this already calls updateSelectedState)
            await this.loadFolders();
            
            // After loading, verify the selection is still valid
            if (currentSelection && currentSelection.path) {
                const folderExists = this.findFolderInList(currentSelection.path);
                if (!folderExists) {
                    // Selected folder no longer exists, reset to "All Folders"
                    console.log('Previously selected folder no longer available, resetting to All Folders');
                    this.folderStorage.saveSelectedFolder('', 'All Folders');
                    this.updateCurrentSelection();
                    this.updateSelectedState();
                }
            }
        } catch (error) {
            console.error('Error refreshing folders:', error);
        }
    }
}

// Export for use in other scripts
window.FolderSelector = FolderSelector;
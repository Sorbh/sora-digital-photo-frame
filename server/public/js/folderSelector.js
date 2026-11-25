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
                <button type="button" class="folder-selector-btn" aria-expanded="false" title="${t('folders.selectForSlideshow')}" data-i18n-attr="title:folders.selectForSlideshow">
                    <span class="material-icons">folder</span>
                    <span class="selected-folder-name">${t('folders.allFoldersTitle')}</span>
                    <span class="material-icons dropdown-arrow">keyboard_arrow_down</span>
                </button>
                
                <div class="folder-dropdown hidden">
                    <div class="folder-dropdown-header">
                        <span data-i18n="folders.selectFolder">${t('folders.selectFolder')}</span>
                        <button type="button" class="close-dropdown" aria-label="${t('common.close')}" data-i18n-attr="aria-label:common.close">
                            <span class="material-icons">close</span>
                        </button>
                    </div>
                    
                    <div class="folder-options">
                        <div class="folder-option all-folders" data-path="">
                            <div class="folder-option-content">
                                <div class="folder-spacer"></div>
                                <button type="button" class="folder-choice">
                                    <span class="material-icons folder-icon" aria-hidden="true">photo_library</span>
                                    <span class="folder-details">
                                        <span class="folder-name" data-i18n="folders.allFoldersTitle">${t('folders.allFoldersTitle')}</span>
                                        <span class="folder-count" data-i18n="folders.allImages">${t('folders.allImages')}</span>
                                    </span>
                                </button>
                            </div>
                        </div>
                        
                        <div class="folder-list">
                            <!-- Folders will be loaded here -->
                        </div>
                    </div>
                    
                    <div class="folder-loading">
                        <div class="loading-spinner"></div>
                        <span data-i18n="folders.loadingFolders">${t('folders.loadingFolders')}</span>
                    </div>
                    
                    <div class="folder-error hidden">
                        <span class="material-icons">error</span>
                        <span class="error-text">${t('slideshow.loadFoldersFailed')}</span>
                        <button class="retry-btn" data-i18n="folders.retry">${t('folders.retry')}</button>
                    </div>
                </div>
            </div>
        `;

        this.setupEventListeners();
        this.addStyles();
        // Static labels above carry data-i18n; the folder list and selection are drawn here
        window.addEventListener('sora:languagechange', () => {
            this.renderFolders();
            this.updateSelectedState();
            this.updateCurrentSelection();
        });
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

            // Handle folder selection: each choice is a button of its own
            const choice = e.target.closest('.folder-choice');
            if (choice) {
                e.preventDefault();
                const folderOption = choice.closest('.folder-option');
                const folderPath = folderOption.dataset.path;
                const folderName = folderOption.querySelector('.folder-name')?.textContent || '';
                this.selectFolder(folderPath, folderName);
                return;
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

        // Arrow keys move between the picker's buttons, for TV remotes without Tab
        // (js/arrowFocus.js); the slideshow doesn't see them
        this.container.querySelector('.folder-dropdown').addEventListener('keydown', (e) => {
            if (!window.SoraArrowFocus || !SoraArrowFocus.DIRECTIONS[e.key]) return;
            e.preventDefault();
            e.stopPropagation();
            const buttons = this.container.querySelectorAll('.folder-dropdown button');
            SoraArrowFocus.next(buttons, document.activeElement, e.key)?.focus();
        });

        // Up from the folder button opens the panel above it, or steps into it
        selectorBtn.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowUp') return;
            e.preventDefault();
            e.stopPropagation();
            if (this.isOpen) this.focusSelected();
            else this.openDropdown();
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

            .folder-option-content {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 7px 10px 7px 8px;
                border-radius: var(--shape-sm);
                transition: background-color 0.15s ease;
            }

            .folder-choice {
                display: flex;
                flex: 1;
                align-items: center;
                gap: 12px;
                min-width: 0;
                padding: 0;
                border: 0;
                border-radius: var(--shape-xs);
                background: transparent;
                color: inherit;
                font: inherit;
                text-align: start;
                cursor: pointer;
            }

            .folder-choice:focus-visible,
            .expand-btn:focus-visible,
            .close-dropdown:focus-visible,
            .folder-selector-btn:focus-visible {
                outline: 2px solid #ff5c8d;
                outline-offset: 2px;
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
                width: 28px;
                height: 28px;
                flex-shrink: 0;
                margin-inline-end: -6px;
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

            /* The closed arrow points the way the text reads */
            [dir="rtl"] .expand-btn[aria-expanded="false"] .material-icons {
                transform: scaleX(-1);
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
                flex: 1;
                gap: 3px;
                min-width: 0;
            }

            .folder-option .folder-name {
                display: block;
                overflow: hidden;
                font: 500 0.95rem/1.2 var(--font-sans, sans-serif);
                white-space: nowrap;
                text-overflow: ellipsis;
            }

            .folder-count {
                display: block;
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
        this.container.querySelector('.folder-selector-btn').setAttribute('aria-expanded', 'true');
        
        // Load folders if not already loaded
        if (this.folders.length === 0 && !this.isLoading) {
            this.loadFolders().then(() => this.focusSelected());
        } else {
            this.focusSelected();
        }
    }

    /**
     * Put focus on the chosen folder, so a keyboard or remote starts there
     */
    focusSelected() {
        if (!this.isOpen) return;
        // Not when the person has moved on while the folders were loading
        const active = document.activeElement;
        if (active && active !== document.body && !this.container.contains(active)) return;
        const choices = this.container.querySelector('.folder-options');
        (choices.querySelector('.folder-option.selected .folder-choice') || choices.querySelector('.folder-choice'))?.focus();
    }

    /**
     * Close dropdown
     */
    closeDropdown() {
        this.isOpen = false;
        const dropdown = this.container.querySelector('.folder-dropdown');
        const hadFocus = dropdown.contains(document.activeElement);
        this.container.classList.remove('open');
        dropdown.classList.add('hidden');
        const toggle = this.container.querySelector('.folder-selector-btn');
        toggle.setAttribute('aria-expanded', 'false');
        // Hand focus back to the button rather than losing it with the hidden panel
        if (hadFocus) toggle.focus();
    }

    /**
     * Load folders from API
     */
    async loadFolders() {
        // Calls made while a load is running share it; resolves true when the list loaded
        if (!this.loadingFolders) {
            this.loadingFolders = this.fetchFolders().finally(() => { this.loadingFolders = null; });
        }
        return this.loadingFolders;
    }

    async fetchFolders() {
        this.showLoading(true);
        this.hideError();
        
        try {
            const data = await this.folderService.getFolderStructure();
            this.folders = data.folders || [];
            this.renderFolders();
            this.updateSelectedState();
            return true;
        } catch (error) {
            console.error('Error loading folders:', error);
            this.showError(error.message);
            return false;
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

        // Redrawing replaces the buttons: keep focus on the same one
        const active = list.contains(document.activeElement) ? document.activeElement : null;
        const focusPath = active?.closest('.folder-option')?.dataset.path;
        const focusPart = active?.classList.contains('expand-btn') ? '.expand-btn' : '.folder-choice';

        list.innerHTML = '';
        this.renderFolderLevel(this.folders, list, 0);

        if (focusPath !== undefined) {
            list.querySelector(`.folder-option[data-path="${CSS.escape(focusPath)}"] ${focusPart}`)?.focus();
        }
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
            
            // Expanding and choosing are separate buttons, so both work from a keyboard or remote
            element.innerHTML = `
                <div class="folder-option-content" style="padding-inline-start: ${indentPadding}px;">
                    ${hasSubfolders ? 
                        `<button type="button" class="expand-btn" aria-expanded="${isExpanded}">
                            <span class="material-icons" aria-hidden="true">${isExpanded ? 'keyboard_arrow_down' : 'keyboard_arrow_right'}</span>
                        </button>` : 
                        `<div class="folder-spacer"></div>`
                    }
                    <button type="button" class="folder-choice">
                        ${folder.thumbnail
                            ? `<img class="folder-thumb" src="${folder.thumbnail}" alt="">`
                            : `<span class="material-icons folder-icon" aria-hidden="true">folder</span>`}
                        <span class="folder-details">
                            <span class="folder-name"></span>
                            ${this.options.showFolderCount ? `<span class="folder-count">${t('folders.imageCount', { count: folder.imageCount })}</span>` : ''}
                        </span>
                    </button>
                </div>
            `;
            element.querySelector('.folder-name').textContent = folder.name;
            element.querySelector('.expand-btn')?.setAttribute('aria-label', t('folders.subfoldersOf', { name: folder.name }));
            if (folder.path === this.folderStorage.getCurrentFolderPath()) {
                element.classList.add('selected');
                element.querySelector('.folder-choice').setAttribute('aria-current', 'true');
            }

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
            nameElement.textContent = selectedFolder && selectedFolder.path ? selectedFolder.name : t('folders.allFoldersTitle');
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
            el.querySelector('.folder-choice')?.removeAttribute('aria-current');
        });
        
        // Add selection to current folder
        const selectedElement = this.container.querySelector(`.folder-option[data-path="${CSS.escape(selectedPath)}"]`);
        if (selectedElement) {
            selectedElement.classList.add('selected');
            selectedElement.querySelector('.folder-choice')?.setAttribute('aria-current', 'true');
            
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
                if (!folderPath.startsWith(`${folder.path}/`)) continue;
                // Subfolders load on demand: a path under an unopened folder is taken on trust
                const subfolders = folder.subfolders || this.loadedSubfolders.get(folder.path);
                if (!subfolders) return true;
                if (searchInFolders(subfolders)) return true;
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
            const loaded = await this.loadFolders();
            
            // After loading, verify the selection is still valid (not when the list failed to load)
            if (loaded && currentSelection && currentSelection.path) {
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
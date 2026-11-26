/**
 * Folder Browser Component - Visual folder selection with thumbnail grid
 */
class FolderBrowser {
    constructor(container, options = {}) {
        this.container = container;
        this.folderService = new FolderService();
        this.folderStorage = new FolderStorage();
        
        // Configuration options
        this.options = {
            showBreadcrumb: options.showBreadcrumb !== false,
            showAllFoldersOption: options.showAllFoldersOption !== false,
            onFolderSelected: options.onFolderSelected || null,
            onFolderChanged: options.onFolderChanged || null,
            ...options
        };
        
        // State
        this.currentPath = '';
        this.currentFolder = null;
        this.isLoading = false;
        this.loadRequest = 0; // only the latest load may draw
        
        this.initializeComponent();
        this.loadCurrentFolder();
    }

    /**
     * Initialize the component HTML structure
     */
    initializeComponent() {
        this.container.innerHTML = `
            <div class="folder-browser">
                ${this.options.showBreadcrumb ? `
                    <div class="folder-breadcrumb">
                        <div class="breadcrumb-container"></div>
                    </div>
                ` : ''}
                
                <div class="folder-controls">
                    ${this.options.showAllFoldersOption ? `
                        <div class="folder-option all-folders-btn" data-path="">
                            <button type="button" class="folder-choice">
                                <span class="folder-icon" aria-hidden="true">
                                    <span class="material-icons">auto_awesome_mosaic</span>
                                </span>
                                <span class="folder-info">
                                    <span class="folder-name" data-i18n="folders.static_005">${t('folders.static_005')}</span>
                                    <span class="folder-count" data-i18n="folders.everyPhoto">${t('folders.everyPhoto')}</span>
                                </span>
                            </button>
                        </div>
                    ` : ''}
                </div>
                
                <div class="folder-grid">
                    <!-- Folders will be loaded here -->
                </div>
                
                <div class="folder-loading hidden">
                    <div class="loading-spinner"></div>
                    <div class="loading-text" data-i18n="folders.loadingFolders">${t('folders.loadingFolders')}</div>
                </div>
                
                <div class="folder-error hidden">
                    <span class="material-icons">error</span>
                    <div class="error-text">${t('slideshow.loadFoldersFailed')}</div>
                    <button class="retry-btn" data-i18n="folders.retry">${t('folders.retry')}</button>
                </div>
            </div>
        `;

        this.setupEventListeners();
        this.addStyles();
        // Static labels above carry data-i18n; folder cards and the breadcrumb are drawn here
        window.addEventListener('sora:languagechange', () => {
            if (!this.currentFolder) return;
            this.renderFolderContent();
            this.updateBreadcrumb();
            this.updateSelectedState();
        });
    }

    /**
     * Set up event listeners
     */
    setupEventListeners() {
        this.container.addEventListener('click', (e) => {
            // Folder navigation (enter subfolder) comes first: browsing doesn't choose the folder
            const navBtn = e.target.closest('.folder-nav');
            if (navBtn) {
                e.preventDefault();
                this.navigateToFolder(navBtn.dataset.path);
                return;
            }

            // Breadcrumb navigation
            const breadcrumbBtn = e.target.closest('.breadcrumb-item');
            if (breadcrumbBtn) {
                e.preventDefault();
                this.navigateToFolder(breadcrumbBtn.dataset.path);
                return;
            }

            // Folder selection: the card's main button
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
                this.loadCurrentFolder();
            }
        });

        // Arrow keys move between the page's buttons and links (folders, Retry, the
        // header and tab bar), for TV remotes without Tab (js/arrowFocus.js).
        // With nothing focused yet, the first arrow lands on the folder playing now,
        // or on Retry when the folders failed to load.
        document.addEventListener('keydown', (e) => {
            if (!window.SoraArrowFocus || !SoraArrowFocus.DIRECTIONS[e.key]) return;
            const active = document.activeElement;
            const buttons = [...document.querySelectorAll('button, a[href]')];
            let target = null;
            if (!active || active === document.body) {
                const retry = this.container.querySelector('.folder-error:not(.hidden) .retry-btn');
                target = retry
                    || this.container.querySelector('.folder-option.selected .folder-choice')
                    || this.container.querySelector('.folder-choice');
            } else if (buttons.includes(active)) {
                target = SoraArrowFocus.next(buttons, active, e.key);
            }
            // Nothing that way: leave the key to the page (scrolling)
            if (!target) return;
            e.preventDefault();
            target.focus();
        });
    }

    /**
     * Add component styles
     */
    addStyles() {
        if (document.getElementById('folder-browser-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'folder-browser-styles';
        styles.textContent = `
            .folder-browser {
                width: 100%;
            }

            .folder-breadcrumb {
                margin-bottom: 16px;
            }

            .breadcrumb-container {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 4px;
            }

            .breadcrumb-item {
                padding: 6px 12px;
                border: 0;
                border-radius: var(--shape-sm);
                background: transparent;
                color: var(--ink-faint);
                font: inherit;
                font-size: 0.75rem;
                font-weight: 700;
                letter-spacing: 0.12em;
                text-transform: uppercase;
                cursor: pointer;
            }

            /* Deep berry on the light page, bright berry at night: 4.5:1 or more */
            .breadcrumb-item:last-child {
                background: var(--blush);
                color: var(--berry-deep);
            }

            .breadcrumb-item:hover {
                color: var(--berry-deep);
            }

            html.dark .breadcrumb-item:last-child,
            html.dark .breadcrumb-item:hover {
                color: var(--berry);
            }

            .breadcrumb-separator {
                color: var(--ink-faint);
                font-size: 0.75rem;
            }

            .folder-controls {
                margin-bottom: 12px;
            }

            .folder-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
                gap: 12px;
            }

            .folder-option {
                position: relative;
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
                min-width: 0;
                padding-inline-end: 14px;
                border: 1.5px solid var(--rule);
                border-radius: var(--shape-md);
                background: var(--paper-raised);
                color: var(--foreground);
                box-shadow: var(--shadow-soft);
                animation: fb-in 0.45s var(--ease-out) both;
                transition: transform 0.25s var(--ease-out), border-color 0.2s ease, box-shadow 0.25s ease;
            }

            @keyframes fb-in {
                from { opacity: 0; transform: translateY(8px); }
                to { opacity: 1; transform: none; }
            }

            /* Choosing the folder: most of the card */
            .folder-choice {
                display: flex;
                flex: 1;
                align-items: center;
                gap: 14px;
                min-width: 0;
                padding: 12px;
                border: 0;
                border-radius: inherit;
                background: transparent;
                color: inherit;
                font: inherit;
                text-align: start;
                cursor: pointer;
            }

            .folder-choice:focus-visible,
            .folder-nav:focus-visible,
            .breadcrumb-item:focus-visible {
                outline: 2px solid var(--berry);
                outline-offset: 2px;
            }

            .folder-option:hover {
                transform: translateY(-2px);
                box-shadow: var(--shadow-lift);
            }

            .folder-option.selected {
                border-color: var(--berry);
                box-shadow: 0 0 0 4px var(--safelight-soft), var(--shadow-soft);
            }

            /* Heart badge on the folder that is playing */
            .folder-option.selected::after {
                content: 'favorite';
                position: absolute;
                top: -8px;
                right: -6px;
                display: grid;
                place-items: center;
                width: 28px;
                height: 28px;
                border: 3px solid var(--paper);
                border-radius: 50%;
                background: var(--berry-gradient);
                color: #fff;
                font-family: 'Material Symbols Outlined';
                font-size: 15px;
                font-variation-settings: 'FILL' 1;
            }

            .folder-thumbnail,
            .folder-icon {
                width: 58px;
                height: 58px;
                flex-shrink: 0;
                border-radius: var(--shape-sm);
            }

            .folder-thumbnail {
                object-fit: cover;
                background: var(--paper-sunk);
            }

            .folder-icon {
                display: grid;
                place-items: center;
                background: var(--honey-soft);
                color: #b07a1c;
            }

            .folder-option:nth-child(3n + 2) .folder-icon { background: var(--teal-soft); color: #4f7f86; }
            .folder-option:nth-child(3n) .folder-icon { background: var(--blush); color: var(--berry); }

            /* No browse arrow here: the button takes the whole card */
            .folder-option.all-folders-btn {
                padding-inline-end: 0;
            }

            .all-folders-btn .folder-icon {
                background: var(--berry-gradient);
                color: #fff;
            }

            .folder-icon .material-icons {
                font-size: 26px;
            }

            .folder-info {
                flex: 1;
                min-width: 0;
            }

            .folder-name {
                display: block;
                overflow: hidden;
                font-weight: 700;
                font-size: 1rem;
                white-space: nowrap;
                text-overflow: ellipsis;
                text-transform: capitalize;
            }

            .folder-count {
                display: block;
                margin-top: 2px;
                font-size: 0.8125rem;
                color: var(--muted-foreground);
            }

            .folder-nav {
                display: grid;
                place-items: center;
                width: 36px;
                height: 36px;
                flex-shrink: 0;
                border: 0;
                border-radius: 50%;
                background: var(--blush);
                color: var(--berry-deep);
                cursor: pointer;
                transition: transform 0.2s var(--ease-out);
            }

            .folder-nav:hover {
                transform: translateX(2px);
            }

            .folder-nav .material-icons {
                font-size: 18px;
            }

            [dir="rtl"] .folder-nav .material-icons {
                transform: scaleX(-1);
            }

            [dir="rtl"] .folder-nav:hover {
                transform: translateX(-2px);
            }

            .folder-loading,
            .folder-error {
                display: grid;
                justify-items: center;
                gap: 10px;
                padding: 3rem 1rem;
                color: var(--muted-foreground);
                text-align: center;
            }

            .folder-loading.hidden,
            .folder-error.hidden {
                display: none;
            }

            .loading-spinner {
                width: 28px;
                height: 28px;
                border: 3px solid var(--blush);
                border-top-color: var(--berry);
                border-radius: 50%;
                animation: fb-spin 0.9s linear infinite;
            }

            @keyframes fb-spin {
                to { transform: rotate(360deg); }
            }

            .folder-error .material-icons {
                font-size: 32px;
                color: var(--destructive);
            }

            .retry-btn {
                padding: 8px 18px;
                border: 0;
                border-radius: var(--shape-sm);
                background: var(--berry-gradient);
                color: #fff;
                font: inherit;
                font-weight: 700;
                cursor: pointer;
            }

            @media (max-width: 640px) {
                .folder-grid {
                    grid-template-columns: minmax(0, 1fr);
                }
            }
        `;
        document.head.appendChild(styles);
    }

    /**
     * Navigate to a specific folder
     * @param {string} folderPath - Path to navigate to
     */
    async navigateToFolder(folderPath) {
        // The button that was pressed goes away with the old cards: start the keyboard on the new ones
        const hadFocus = this.container.contains(document.activeElement);
        this.currentPath = folderPath;
        const shown = await this.loadCurrentFolder();
        // Only if this is still the folder shown and focus went with the old cards,
        // not if the person moved on (another folder, another part of the page)
        const lost = !document.activeElement || document.activeElement === document.body;
        if (shown && hadFocus && lost) {
            (this.container.querySelector('.folder-grid .folder-choice')
                || this.container.querySelector('.breadcrumb-item:last-child'))?.focus();
        }
    }

    /**
     * Select a folder (save selection and trigger callback)
     * @param {string} folderPath - Selected folder path
     * @param {string} folderName - Display name of selected folder
     */
    selectFolder(folderPath, folderName) {
        // Save selection
        this.folderStorage.saveSelectedFolder(folderPath, folderName);
        
        // Update visual state
        this.updateSelectedState();
        
        // Trigger callbacks
        if (this.options.onFolderSelected) {
            this.options.onFolderSelected(folderPath, folderName);
        }
        
        if (this.options.onFolderChanged) {
            this.options.onFolderChanged(folderPath, folderName);
        }
    }

    /**
     * Load current folder data from API
     */
    async loadCurrentFolder() {
        // A newer load (browsing again before this one arrived) wins: older answers are dropped.
        // Resolves true when this load is the one drawn.
        const request = ++this.loadRequest;
        const latest = () => request === this.loadRequest;
        
        this.showLoading(true);
        this.hideError();
        
        try {
            const data = await this.folderService.getFolderStructure(this.currentPath);
            if (!latest()) return false;
            this.currentFolder = data;
            this.renderFolderContent();
            this.updateBreadcrumb();
            this.updateSelectedState();
            return true;
        } catch (error) {
            if (!latest()) return false;
            console.error('Error loading folder:', error);
            this.showError(error.message);
            return false;
        } finally {
            if (latest()) this.showLoading(false);
        }
    }

    /**
     * Render folder content in the grid
     */
    renderFolderContent() {
        const grid = this.container.querySelector('.folder-grid');
        if (!grid) return;

        grid.innerHTML = '';

        if (this.currentFolder.folders) {
            // Root level - show all folders
            this.currentFolder.folders.forEach(folder => {
                grid.appendChild(this.createFolderElement(folder));
            });
        } else if (this.currentFolder.subfolders) {
            // Specific folder - show subfolders
            this.currentFolder.subfolders.forEach(folder => {
                grid.appendChild(this.createFolderElement(folder));
            });
        }
    }

    /**
     * Create folder element
     * A card holds two buttons: the folder itself to choose it, and an arrow
     * to browse its subfolders (only when it has some)
     * @param {Object} folder - Folder data
     * @returns {HTMLElement} Folder element
     */
    createFolderElement(folder) {
        const element = document.createElement('div');
        element.className = 'folder-option';
        element.dataset.path = folder.path;

        const thumbnailHtml = folder.thumbnail 
            ? `<img src="${folder.thumbnail}" alt="" class="folder-thumbnail" loading="lazy">`
            : `<span class="folder-icon" aria-hidden="true"><span class="material-icons">folder</span></span>`;

        const navigationBtn = folder.hasSubfolders 
            ? `<button type="button" class="folder-nav" title="${t('folders.browseFolder')}">
                 <span class="material-icons" aria-hidden="true">arrow_forward</span>
               </button>`
            : '';

        element.innerHTML = `
            <button type="button" class="folder-choice">
                ${thumbnailHtml}
                <span class="folder-info">
                    <span class="folder-name"></span>
                    <span class="folder-count">${t('folders.photoCount', { count: folder.imageCount })}</span>
                </span>
            </button>
            ${navigationBtn}
        `;
        element.querySelector('.folder-name').textContent = folder.name;
        const navBtn = element.querySelector('.folder-nav');
        if (navBtn) {
            navBtn.dataset.path = folder.path;
            navBtn.setAttribute('aria-label', t('folders.browseNamed', { name: folder.name }));
        }

        return element;
    }

    /**
     * Update breadcrumb navigation
     */
    updateBreadcrumb() {
        if (!this.options.showBreadcrumb) return;
        
        const container = this.container.querySelector('.breadcrumb-container');
        if (!container) return;

        container.innerHTML = '';

        if (this.currentFolder.folder && this.currentFolder.folder.breadcrumb) {
            this.currentFolder.folder.breadcrumb.forEach((item, index) => {
                if (index > 0) {
                    const separator = document.createElement('span');
                    separator.className = 'breadcrumb-separator';
                    separator.textContent = '›';
                    container.appendChild(separator);
                }

                const breadcrumbItem = document.createElement('button');
                breadcrumbItem.className = 'breadcrumb-item';
                breadcrumbItem.dataset.path = item.path;
                breadcrumbItem.textContent = item.name;
                container.appendChild(breadcrumbItem);
            });
        } else {
            // Root level
            const rootItem = document.createElement('button');
            rootItem.className = 'breadcrumb-item';
            rootItem.dataset.path = '';
            rootItem.textContent = t('folders.allFoldersTitle');
            container.appendChild(rootItem);
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
        }
    }

    /**
     * Show/hide loading state
     * @param {boolean} show - Whether to show loading
     */
    showLoading(show) {
        this.isLoading = show;
        const loading = this.container.querySelector('.folder-loading');
        const grid = this.container.querySelector('.folder-grid');
        
        if (loading) {
            loading.classList.toggle('hidden', !show);
        }
        if (grid) {
            grid.style.opacity = show ? '0.5' : '1';
        }
    }

    /**
     * Show error message
     * @param {string} message - Error message to display
     */
    showError(message) {
        const error = this.container.querySelector('.folder-error');
        const errorText = this.container.querySelector('.error-text');
        
        if (error) {
            error.classList.remove('hidden');
        }
        if (errorText) {
            errorText.textContent = message;
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
     * Refresh the current view
     */
    refresh() {
        this.loadCurrentFolder();
    }
}

// Export for use in other scripts
window.FolderBrowser = FolderBrowser;
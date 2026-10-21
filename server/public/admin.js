/**
 * Page-wide toast via Basecoat, shared by admin.js, settings.js and googlePhotosSync.js.
 */
const TOAST_TITLES = { success: 'Success!', error: 'Error!', warning: 'Warning!', info: 'Info' };

function showToast(message, type = 'info') {
    const category = type in TOAST_TITLES ? type : 'info';
    document.dispatchEvent(new CustomEvent('basecoat:toast', {
        detail: {
            config: { category, title: TOAST_TITLES[category], description: message, duration: 5000 }
        }
    }));
}
window.showToast = showToast;

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
}

// Drag payload for photos moved inside the library (a JSON list of admin paths)
const PHOTO_DRAG_TYPE = 'application/x-sora-photos';

const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
const isPhotoDrag = (e) => Array.from(e.dataTransfer?.types || []).includes(PHOTO_DRAG_TYPE);

class PhotoFrameAdmin {
    constructor() {
        this.currentPath = this.getInitialPath();
        this.selectedFiles = [];
        this.emptyStateSelectedFiles = []; // For empty state upload
        this.selectedItems = new Set(); // For multi-select
        this.contextMenuTarget = null;
        this.longPressTimeout = null;
        this.longPressDelay = 500; // 500ms for long press
        
        // Photo modal zoom/pan state
        this.isZoomed = false;
        this.dragState = { isDragging: false, startX: 0, startY: 0, translateX: 0, translateY: 0 };
        
        // Photo modal navigation state
        this.currentImageIndex = -1;
        this.availableImages = [];
        
        this.initializeEventListeners();
        this.updateURL(); // Ensure URL reflects current path
        this.loadFolderContents();
        this.checkFeatureFlags();
    }

    // Handle API responses and check for session expiration
    async handleApiResponse(response) {
        if (response.status === 401) {
            try {
                const data = await response.json();
                if (data.code === 'SESSION_EXPIRED' || data.code === 'AUTH_REQUIRED') {
                    this.handleSessionExpired();
                    return null;
                }
            } catch (e) {
                // If we can't parse JSON, still handle as session expired
                this.handleSessionExpired();
                return null;
            }
        }
        return response;
    }

    // Handle session expiration
    handleSessionExpired() {
        // Use Basecoat error toast for session expiration
        document.dispatchEvent(new CustomEvent('basecoat:toast', {
            detail: {
                config: {
                    category: 'error',
                    title: 'Session Expired',
                    description: 'Your session has expired. Redirecting to login...',
                    duration: 8000 // Longer duration for important message
                }
            }
        }));
        
        setTimeout(() => {
            window.location.href = '/login?expired=true';
        }, 2000);
    }

    // Wrapper for fetch with session handling
    async authenticatedFetch(url, options = {}) {
        try {
            const response = await fetch(url, options);
            const handledResponse = await this.handleApiResponse(response);
            return handledResponse;
        } catch (error) {
            console.error('Network error:', error);
            throw error;
        }
    }

    getInitialPath() {
        // Check URL search parameters first (?path=folder)
        const urlParams = new URLSearchParams(window.location.search);
        const pathParam = urlParams.get('path');
        
        if (pathParam) {
            return pathParam;
        }
        
        // Check hash fragment (#/folder)
        const hash = window.location.hash;
        if (hash && hash.startsWith('#/')) {
            const hashPath = hash.substring(2); // Remove #/
            if (hashPath && hashPath !== 'uploads') {
                return `uploads/${hashPath}`;
            }
        }
        
        return 'uploads';
    }

    updateURL() {
        const url = new URL(window.location);
        if (this.currentPath === 'uploads') {
            url.searchParams.delete('path');
        } else {
            url.searchParams.set('path', this.currentPath);
        }
        window.history.replaceState({}, '', url);
    }

    initializeEventListeners() {
        // Navigation
        document.getElementById('backBtn').addEventListener('click', () => this.navigateBack());
        
        // Access Accounts
        document.getElementById('accessAccountsBtn').addEventListener('click', () => {
            window.location.href = '/access-accounts';
        });
        
        // Breadcrumb navigation
        document.getElementById('breadcrumbContainer').addEventListener('click', (e) => {
            if (e.target.classList.contains('breadcrumb-item')) {
                this.navigateTo(e.target.dataset.path);
            }
        });

        // Create folder
        document.getElementById('createFolderBtn').addEventListener('click', () => this.showCreateFolderModal());
        document.getElementById('createSnapBtn').addEventListener('click', () => this.createSnap());
        document.getElementById('confirmCreateBtn').addEventListener('click', () => this.createFolder());
        document.getElementById('cancelCreateBtn').addEventListener('click', () => this.hideCreateFolderModal());
        document.getElementById('closeCreateFolderModal').addEventListener('click', () => this.hideCreateFolderModal());

        // Upload
        document.getElementById('uploadBtn').addEventListener('click', () => this.showUploadModal());
        document.getElementById('closeUploadModal').addEventListener('click', () => this.hideUploadModal());
        
        // Logout
        document.getElementById('logoutBtn').addEventListener('click', () => this.logout());
        
        // Theme toggle with system option
        document.getElementById('themeToggle').addEventListener('click', () => {
            const currentMode = localStorage.getItem('themeMode') || 'system';
            let nextMode;
            
            // Cycle through: light → dark → system → light
            switch (currentMode) {
                case 'light':
                    nextMode = 'dark';
                    break;
                case 'dark':
                    nextMode = 'system';
                    break;
                case 'system':
                default:
                    nextMode = 'light';
                    break;
            }
            
            document.dispatchEvent(new CustomEvent('basecoat:theme', {
                detail: { mode: nextMode }
            }));
            
            this.updateThemeButton(nextMode);
        });
        
        document.getElementById('confirmUploadBtn').addEventListener('click', () => this.uploadFiles());
        document.getElementById('cancelUploadBtn').addEventListener('click', () => this.hideUploadModal());
        document.getElementById('uploadDropZone').addEventListener('click', () => document.getElementById('fileInput').click());

        // File input
        document.getElementById('fileInput').addEventListener('change', (e) => {
            this.selectedFiles = Array.from(e.target.files);
            this.updateUploadButton();
            this.updateSelectedFilesDisplay();
        });

        // Drag and drop for upload modal
        this.setupUploadDragAndDrop();
        
        // Main drop zone
        this.setupMainDragAndDrop();

        // Empty state drag and drop
        this.setupEmptyStateDragAndDrop();

        // Context menu. The popover is "manual" because the browser's light dismiss
        // closes it on the mouse-up of the same right-click that opened it.
        document.addEventListener('pointerdown', (e) => {
            if (e.button === 0 && !e.target.closest('#contextMenuPopover, .folder-more')) {
                this.hideContextMenu();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hideContextMenu();
        });
        window.addEventListener('resize', () => this.hideContextMenu());
        document.addEventListener('scroll', () => this.hideContextMenu(), { capture: true, passive: true });
        document.getElementById('contextMenuPopover').addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.closest('.menu-item')) {
                this.handleContextMenuAction(e.target.closest('.menu-item').dataset.action);
            }
        });

        // Folder name input enter key
        document.getElementById('folderNameInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.createFolder();
            }
        });

        // Modal backdrop clicks for dialog elements
        document.getElementById('createFolderModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                this.hideCreateFolderModal();
            }
        });

        document.getElementById('uploadModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                this.hideUploadModal();
            }
        });

        // Photo modal
        document.getElementById('closePhotoModal').addEventListener('click', () => this.hidePhotoModal());
        document.getElementById('photoModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                this.hidePhotoModal();
            }
        });

        // Keyboard support for photo modal
        document.addEventListener('keydown', (e) => {
            if (document.getElementById('photoModal').open) {
                switch (e.key) {
                    case 'Escape':
                        this.hidePhotoModal();
                        break;
                    case 'ArrowLeft':
                        e.preventDefault();
                        this.navigateToPreviousImage();
                        break;
                    case 'ArrowRight':
                        e.preventDefault();
                        this.navigateToNextImage();
                        break;
                }
            }
        });

        // Selection controls
        document.getElementById('bulkDeleteBtn').addEventListener('click', () => this.showBulkDeleteModal());
        
        // Bulk delete modal
        document.getElementById('cancelBulkDeleteBtn').addEventListener('click', () => this.hideBulkDeleteModal());
        document.getElementById('confirmBulkDeleteBtn').addEventListener('click', () => this.confirmBulkDelete());
        document.getElementById('closeBulkDeleteModal').addEventListener('click', () => this.hideBulkDeleteModal());
        document.getElementById('bulkDeleteModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                this.hideBulkDeleteModal();
            }
        });

        // Google Photos modal
        document.getElementById('cancelGooglePhotosBtn').addEventListener('click', () => {
            if (window.googlePhotosSync) {
                window.googlePhotosSync.hideGooglePhotosModal();
            }
        });

        document.getElementById('googlePhotosModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                if (window.googlePhotosSync) {
                    window.googlePhotosSync.hideGooglePhotosModal();
                }
            }
        });

        // Empty state upload functionality
        document.getElementById('emptyStateUploadZone').addEventListener('click', () => {
            document.getElementById('emptyStateFileInput').click();
        });

        document.getElementById('emptyStateFileInput').addEventListener('change', (e) => {
            this.handleEmptyStateFileSelection(Array.from(e.target.files));
        });

        document.getElementById('emptyStateUploadBtn').addEventListener('click', () => {
            this.uploadEmptyStateFiles();
        });

        document.getElementById('emptyStateCancelBtn').addEventListener('click', () => {
            this.resetEmptyStateUpload();
        });

        // Session buttons (will be available after Google Photos sync loads)
        document.addEventListener('click', (e) => {
            if (e.target.id === 'openSessionBtn' && window.googlePhotosSync) {
                window.googlePhotosSync.openPickerSession();
            }
            if (e.target.id === 'retrySessionBtn' && window.googlePhotosSync) {
                window.googlePhotosSync.createPickerSession();
            }
        });
        
        // Initialize theme button on page load
        this.updateThemeButton(localStorage.getItem('themeMode') || 'system');
    }

    updateThemeButton(mode) {
        const themeButton = document.getElementById('themeToggle');
        const themeIcon = document.getElementById('themeIcon');
        
        switch (mode) {
            case 'light':
                themeIcon.textContent = 'light_mode';
                themeButton.title = 'Switch to dark mode';
                break;
            case 'dark':
                themeIcon.textContent = 'dark_mode';
                themeButton.title = 'Switch to system theme';
                break;
            case 'system':
                themeIcon.textContent = 'brightness_auto';
                themeButton.title = 'Switch to light mode';
                break;
        }
    }

    setupUploadDragAndDrop() {
        const dropZone = document.getElementById('uploadDropZone');
        
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            
            const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
            this.selectedFiles = files;
            this.updateUploadButton();
            this.updateSelectedFilesDisplay();
        });
    }

    // Files dragged in from the computer: anywhere on the page uploads to the
    // open folder, a folder tile uploads into that folder.
    setupMainDragAndDrop() {
        const app = document.querySelector('.app');
        let hideTimer = null;

        // dragleave fires for every child, so the highlight stays on while
        // dragover keeps arriving and drops a moment after it stops
        const keepHighlight = () => {
            app.classList.add('file-dragging');
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => app.classList.remove('file-dragging'), 150);
        };

        // Drop boxes that handle files themselves (upload dialog, empty state)
        // call preventDefault first, so they are left alone here
        // The whole window uploads to the open folder, except while a dialog is up
        const pageTakesDrop = () => !document.querySelector('dialog[open]');

        document.addEventListener('dragover', (e) => {
            if (!isFileDrag(e) || e.defaultPrevented) return;
            e.preventDefault(); // never let the browser open a dropped photo
            if (pageTakesDrop()) {
                e.dataTransfer.dropEffect = 'copy';
                keepHighlight();
            } else {
                e.dataTransfer.dropEffect = 'none';
            }
        });

        document.addEventListener('drop', (e) => {
            if (!isFileDrag(e) || e.defaultPrevented) return;
            e.preventDefault();
            if (!pageTakesDrop()) return;
            app.classList.remove('file-dragging');
            this.uploadDroppedFiles(e, this.currentPath);
        });

        // The back button and breadcrumb take photos up to a parent folder
        this.makeDropTarget(document.getElementById('backBtn'), () => this.parentPath(), { files: false });
        const breadcrumb = document.getElementById('breadcrumbContainer');
        breadcrumb.addEventListener('dragover', (e) => {
            const item = e.target.closest('.breadcrumb-item');
            if (!item || item.dataset.path === this.currentPath || !isPhotoDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            item.classList.add('drop-target');
        });
        breadcrumb.addEventListener('dragleave', (e) => {
            e.target.closest?.('.breadcrumb-item')?.classList.remove('drop-target');
        });
        breadcrumb.addEventListener('drop', (e) => {
            const item = e.target.closest('.breadcrumb-item');
            if (!item || item.dataset.path === this.currentPath || !isPhotoDrag(e)) return;
            e.preventDefault();
            item.classList.remove('drop-target');
            this.moveDroppedPhotos(e, item.dataset.path);
        });
    }

    parentPath() {
        const parts = this.currentPath.split('/');
        parts.pop();
        return parts.join('/') || 'uploads';
    }

    // Accept library photos (move) and, optionally, files from the computer (upload)
    makeDropTarget(element, getPath, { files = true } = {}) {
        const accepts = (e) => isPhotoDrag(e) || (files && isFileDrag(e));

        element.addEventListener('dragover', (e) => {
            if (!accepts(e)) return;
            e.preventDefault();
            e.stopPropagation(); // the library-wide upload highlight is not the target here
            e.dataTransfer.dropEffect = isPhotoDrag(e) ? 'move' : 'copy';
            element.classList.add('drop-target');
        });
        element.addEventListener('dragleave', (e) => {
            if (!element.contains(e.relatedTarget)) element.classList.remove('drop-target');
        });
        element.addEventListener('drop', (e) => {
            if (!accepts(e)) return;
            e.preventDefault();
            e.stopPropagation();
            element.classList.remove('drop-target');
            document.querySelector('.app').classList.remove('file-dragging');
            if (isPhotoDrag(e)) {
                this.moveDroppedPhotos(e, getPath());
            } else {
                this.uploadDroppedFiles(e, getPath());
            }
        });
    }

    uploadDroppedFiles(e, targetPath) {
        const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
        if (files.length > 0) {
            this.uploadFilesDirectly(files, targetPath);
        } else {
            this.showToast('Only image files can be uploaded', 'warning');
        }
    }

    moveDroppedPhotos(e, destination) {
        let paths = [];
        try {
            paths = JSON.parse(e.dataTransfer.getData(PHOTO_DRAG_TYPE));
        } catch {
            return;
        }
        if (Array.isArray(paths) && paths.length > 0) this.movePhotos(paths, destination);
    }

    async movePhotos(paths, destination) {
        const folderName = destination === 'uploads' ? 'Library' : destination.split('/').pop();
        try {
            const response = await this.authenticatedFetch('/api/images/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths, destination })
            });
            if (!response) return; // Session expired

            const data = await response.json();
            if (!response.ok && response.status !== 207) {
                this.showToast(data.message || 'Could not move photos', 'error');
                return;
            }

            const moved = data.movedCount || 0;
            if (moved > 0) {
                this.showToast(`Moved ${moved} ${moved === 1 ? 'photo' : 'photos'} to ${folderName}`, 'success');
            }
            if (data.failedCount > 0) {
                this.showToast(`${data.failedCount} ${data.failedCount === 1 ? 'photo' : 'photos'} could not be moved`, 'error');
            }
            this.loadFolderContents();
        } catch (error) {
            console.error('Error moving photos:', error);
            this.showToast('Could not move photos', 'error');
        }
    }

    async loadFolderContents() {
        this.clearSelection(); // Clear selection when navigating
        
        try {
            const response = await this.authenticatedFetch(`/api/admin/folders?path=${encodeURIComponent(this.currentPath)}`);
            if (!response) return; // Session expired, handled by authenticatedFetch
            
            const data = await response.json();
            
            if (response.ok) {
                this.renderFolderContents(data);
                this.updateBreadcrumb();
                this.updateBackButton();
            } else {
                this.showToast(data.message || 'Failed to load folder contents', 'error');
            }
        } catch (error) {
            console.error('Error loading folder contents:', error);
            this.showToast('Failed to load folder contents', 'error');
        }
    }

    renderFolderContents(data) {
        const fileGrid = document.getElementById('fileGrid');
        const emptyState = document.getElementById('emptyState');
        
        fileGrid.innerHTML = '';
        
        // Update available images for navigation
        // Snaps open in their own editor, so the photo viewer steps over them
        this.availableImages = data.files.filter(file => file.type !== 'snap').map((file, index) => ({
            ...file,
            index: index
        }));
        this.currentImageIndex = -1;

        this.updateLibraryHeading(data);
        
        // Background hint under the grid; the empty state has its own upload box
        const isEmpty = data.folders.length === 0 && data.files.length === 0;
        const folderName = this.currentPath === 'uploads' ? 'Library' : this.currentPath.split('/').pop();
        document.getElementById('dropHint').classList.toggle('hidden', isEmpty);
        document.querySelectorAll('.drop-folder-name').forEach(el => { el.textContent = folderName; });
        document.getElementById('dropHintMove').classList.toggle('hidden', !(data.folders.length && data.files.length));

        if (isEmpty) {
            emptyState.classList.remove('hidden');
            return;
        }
        
        emptyState.classList.add('hidden');
        
        // Add Google Photos import cell if user is authenticated
        if (window.googlePhotosSync && window.googlePhotosSync.isAuthenticated) {
            const importElement = this.createGooglePhotosImportElement();
            fileGrid.appendChild(importElement);
        }
        
        // Render folders
        if (data.folders.length > 0) fileGrid.appendChild(this.createGridLabel('Folders'));
        data.folders.forEach(folder => {
            const folderElement = this.createFolderElement(folder);
            fileGrid.appendChild(folderElement);
        });
        
        // Render files
        if (data.files.length > 0) fileGrid.appendChild(this.createGridLabel('Photos'));
        data.files.forEach(file => {
            const fileElement = this.createFileElement(file);
            fileGrid.appendChild(fileElement);
        });
    }

    updateLibraryHeading(data) {
        const parts = this.currentPath.split('/');
        const title = document.getElementById('folderTitle');
        const meta = document.getElementById('folderMeta');

        if (title) title.textContent = parts.length > 1 ? parts[parts.length - 1] : 'Library';
        if (meta) {
            const folders = data.folders.length;
            const snaps = data.files.filter(file => file.type === 'snap').length;
            const photos = data.files.length - snaps;
            const counts = [];
            if (folders) counts.push(`${folders} ${folders === 1 ? 'folder' : 'folders'}`);
            counts.push(`${photos} ${photos === 1 ? 'photo' : 'photos'}`);
            if (snaps) counts.push(`${snaps} ${snaps === 1 ? 'snap' : 'snaps'}`);
            meta.textContent = counts.join(' · ');
        }
    }

    createGridLabel(text) {
        const label = document.createElement('h2');
        label.className = 'grid-label';
        label.textContent = text;
        return label;
    }

    createFolderElement(folder) {
        const div = document.createElement('div');
        div.className = 'file-item folder';
        div.dataset.path = folder.path;
        div.dataset.type = 'folder';

        // Cover image comes from the first photo inside the folder (null when empty)
        div.innerHTML = `
            <div class="folder-cover">
                <img class="folder-cover-img" alt="" loading="lazy" decoding="async">
                <div class="folder-cover-empty">
                    <span class="material-symbols-outlined">folder_open</span>
                </div>
            </div>
            <div class="folder-meta">
                <div class="folder-name"></div>
                <button type="button" class="folder-more" aria-label="Folder options" aria-haspopup="menu">
                    <span class="material-symbols-outlined">more_vert</span>
                </button>
                <span class="folder-kind material-symbols-outlined" aria-hidden="true">chevron_right</span>
            </div>
        `;
        div.querySelector('.folder-name').textContent = folder.name;
        const cover = div.querySelector('.folder-cover-img');
        if (folder.thumbnail) {
            cover.addEventListener('error', () => div.classList.add('no-cover'));
            cover.src = folder.thumbnail;
        } else {
            div.classList.add('no-cover');
        }

        // The next photos fill the prints behind the cover; tinted paper when there are none
        const coverBox = div.querySelector('.folder-cover');
        (folder.prints || []).slice(0, 2).forEach((url, i) => {
            coverBox.style.setProperty(`--print-${i + 1}`, `url("${url.replace(/["\\]/g, "")}")`);
        });
        
        // Drop photos from the grid (move) or the computer (upload) onto the folder
        this.makeDropTarget(div, () => folder.path);

        // Options button: same menu as right-click, reachable by mouse, touch and keyboard
        div.querySelector('.folder-more').addEventListener('click', (e) => {
            e.stopPropagation();
            this.showContextMenu(e, {...folder, type: 'folder'});
        });

        div.addEventListener('click', () => this.navigateTo(folder.path));
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, {...folder, type: 'folder'}));
        
        return div;
    }

    // A snap is a memory-book page saved in the folder; it opens in the snap editor
    openSnap(file) {
        window.location.href = `/snap?path=${encodeURIComponent(file.path)}`;
    }

    createFileElement(file) {
        const isSnap = file.type === 'snap';
        const type = isSnap ? 'snap' : 'image';
        const div = document.createElement('div');
        div.className = isSnap ? 'file-item image snap' : 'file-item image';
        div.dataset.path = file.path;
        div.dataset.type = type;
        div.innerHTML = `
            <div class="admin-photo-image">
                <img src="${file.thumbnail || file.url}" alt="" loading="lazy" decoding="async">
            </div>
            <div class="photo-grid-overlay">
                <div class="photo-grid-overlay-top">
                    <div class="photo-grid-checkbox">
                        <label class="label">
                            <input type="checkbox" class="input" aria-label="Select Photo">
                            <span class="sr-only">Select Photo</span>
                        </label>
                    </div>
                </div>
                <div class="photo-grid-overlay-bottom">
                    <div class="photo-grid-actions">
                        <button class="btn-icon" data-tooltip="View Photo" data-action="view" aria-label="View Photo">
                            <span class="material-symbols-outlined">visibility</span>
                        </button>
                        <button class="btn-icon" data-tooltip="Delete Photo" data-action="delete" aria-label="Delete Photo">
                            <span class="material-symbols-outlined">delete</span>
                        </button>
                    </div>
                </div>
            </div>
            <div class="photo-grid-info">
                <div class="photo-grid-name"></div>
            </div>
        `;
        // File names come from uploads, so set them as text rather than HTML
        div.querySelector('img').alt = file.name;
        div.querySelector('.photo-grid-name').textContent = file.name;
        if (isSnap) this.dressSnapTile(div, file);
        div.querySelector('input[type="checkbox"]').dataset.path = file.path;
        
        // Handle checkbox selection
        const checkbox = div.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            this.toggleSelection(file);
        });
        
        // Handle action buttons
        const actionButtons = div.querySelectorAll('.btn-icon');
        actionButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent cell selection
                const action = button.getAttribute('data-action');
                if (action === 'view') {
                    if (isSnap) this.openSnap(file);
                    else this.showPhotoModal(file.url, file.name);
                } else if (action === 'delete') {
                    this.deleteItem({...file, type});
                }
            });
        });
        
        // Drag onto a folder to move it; a selected photo brings the whole selection along
        div.draggable = true;
        div.querySelector('img').draggable = false;
        div.addEventListener('dragstart', (e) => {
            this.cancelLongPress();
            div.classList.remove('selecting');
            const paths = this.selectedItems.has(file.path) ? [...this.selectedItems] : [file.path];
            e.dataTransfer.setData(PHOTO_DRAG_TYPE, JSON.stringify(paths));
            e.dataTransfer.effectAllowed = 'move';
            document.querySelector('.app').classList.add('photo-dragging');
            paths.forEach(p => document.querySelector(`.file-item[data-path="${CSS.escape(p)}"]`)?.classList.add('dragging'));
        });
        div.addEventListener('dragend', () => {
            document.querySelector('.app').classList.remove('photo-dragging');
            document.querySelectorAll('.file-item.dragging').forEach(el => el.classList.remove('dragging'));
            document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        });

        // Add long press for mobile
        div.addEventListener('mousedown', (e) => this.handlePointerDown(e, file, div));
        div.addEventListener('touchstart', (e) => this.handlePointerDown(e, file, div), { passive: false });
        div.addEventListener('mouseup', (e) => this.handlePointerUp(e, file, div));
        div.addEventListener('touchend', (e) => this.handlePointerUp(e, file, div));
        div.addEventListener('mouseleave', () => this.cancelLongPress());
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, {...file, type}));
        
        // Regular click handler for photo modal
        div.addEventListener('click', (e) => {
            // Don't open modal if clicking on checkbox or action buttons
            if (e.target.closest('.photo-grid-checkbox') || e.target.closest('.btn-icon')) return;
            if (!this.longPressTriggered) {
                e.preventDefault();
                if (isSnap) this.openSnap(file);
                else this.showPhotoModal(file.url, file.name);
            }
        });
        
        return div;
    }

    // Draw the snap's page in place of a thumbnail, as the frame will show it
    dressSnapTile(div, file) {
        const snap = file.snap || {};
        const stage = document.createElement('div');
        stage.className = 'note-stage snap-tile-stage';
        stage.appendChild(NotePage.render({ ...snap, photos: (snap.photoUrls || []).map(p => p.thumbnail) }, { fill: true }));
        div.querySelector('.admin-photo-image').replaceChildren(stage);

        const badge = document.createElement('span');
        badge.className = 'snap-badge';
        badge.innerHTML = '<span class="material-symbols-outlined">auto_stories</span>Snap';
        div.appendChild(badge);

        div.querySelector('.photo-grid-name').textContent = snap.title || file.name;
        const view = div.querySelector('[data-action="view"]');
        view.dataset.tooltip = 'Edit Snap';
        view.setAttribute('aria-label', 'Edit Snap');
        view.querySelector('.material-symbols-outlined').textContent = 'edit';
        const del = div.querySelector('[data-action="delete"]');
        del.dataset.tooltip = 'Delete Snap';
        del.setAttribute('aria-label', 'Delete Snap');
    }

    createGooglePhotosImportElement() {
        const div = document.createElement('div');
        div.className = 'file-item google-photos-import';
        div.dataset.type = 'google-photos-import';
        div.innerHTML = `
            <span class="material-icons">add</span>
            <span class="import-text">Import from Google Photos</span>
        `;
        
        div.addEventListener('click', () => this.openGooglePhotosImport());
        
        return div;
    }

    openGooglePhotosImport() {
        if (window.googlePhotosSync) {
            window.googlePhotosSync.openGooglePhotosModal(this.currentPath);
        } else {
            this.showToast('Google Photos integration not available', 'error');
        }
    }

    navigateTo(path) {
        this.currentPath = path;
        this.updateURL();
        this.loadFolderContents();
    }

    navigateBack() {
        if (this.currentPath === 'uploads') return;
        
        const pathParts = this.currentPath.split('/');
        pathParts.pop();
        this.currentPath = pathParts.join('/') || 'uploads';
        this.updateURL();
        this.loadFolderContents();
    }

    updateBreadcrumb() {
        const container = document.getElementById('breadcrumbContainer');
        const pathParts = this.currentPath.split('/');
        
        container.innerHTML = '';
        
        let currentPath = '';
        pathParts.forEach((part, index) => {
            if (index > 0) currentPath += '/';
            currentPath += part;
            
            // Add separator before each item except the first
            if (index > 0) {
                const separatorLi = document.createElement('li');
                separatorLi.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" 
                         fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="m9 18 6-6-6-6"/>
                    </svg>
                `;
                container.appendChild(separatorLi);
            }
            
            // Create list item for breadcrumb
            const li = document.createElement('li');
            const span = document.createElement('span');
            span.className = 'breadcrumb-item';
            
            // Style the breadcrumb item based on whether it's the current page
            const isCurrentPage = index === pathParts.length - 1;
            if (isCurrentPage) {
                span.className += ' text-foreground font-medium';
            } else {
                span.className += ' cursor-pointer hover:text-foreground transition-colors';
            }
            
            span.dataset.path = currentPath;
            span.textContent = index === 0 ? 'Home' : part;
            
            li.appendChild(span);
            container.appendChild(li);
        });
    }

    updateBackButton() {
        const backBtn = document.getElementById('backBtn');
        backBtn.style.display = this.currentPath === 'uploads' ? 'none' : 'flex';
    }

    showCreateFolderModal() {
        const modal = document.getElementById('createFolderModal');
        modal.showModal();
        document.getElementById('folderNameInput').focus();
    }

    hideCreateFolderModal() {
        const modal = document.getElementById('createFolderModal');
        modal.close();
        document.getElementById('folderNameInput').value = '';
    }

    async createFolder() {
        const name = document.getElementById('folderNameInput').value.trim();
        
        if (!name) {
            this.showToast('Please enter a folder name', 'error');
            return;
        }
        
        try {
            const response = await this.authenticatedFetch('/api/admin/folders', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: name,
                    path: this.currentPath
                })
            });
            if (!response) return; // Session expired
            
            const data = await response.json();
            
            if (response.ok) {
                this.showToast('Folder created successfully', 'success');
                this.hideCreateFolderModal();
                this.loadFolderContents();
            } else {
                this.showToast(data.message || 'Failed to create folder', 'error');
            }
        } catch (error) {
            console.error('Error creating folder:', error);
            this.showToast('Failed to create folder', 'error');
        }
    }

    showUploadModal() {
        const modal = document.getElementById('uploadModal');
        modal.showModal();
        this.selectedFiles = [];
        this.updateUploadButton();
        this.updateSelectedFilesDisplay();
    }

    hideUploadModal() {
        const modal = document.getElementById('uploadModal');
        modal.close();
        document.getElementById('fileInput').value = '';
        this.selectedFiles = [];
        this.hideUploadProgress();
        this.updateSelectedFilesDisplay();
    }

    updateUploadButton() {
        const btn = document.getElementById('confirmUploadBtn');
        const btnText = document.getElementById('uploadBtnText');
        btn.disabled = this.selectedFiles.length === 0;
        
        if (this.selectedFiles.length > 0) {
            btnText.textContent = `Upload ${this.selectedFiles.length} file${this.selectedFiles.length > 1 ? 's' : ''}`;
        } else {
            btnText.textContent = 'Select Files';
        }
    }

    updateSelectedFilesDisplay() {
        const selectedFilesInfo = document.getElementById('selectedFilesInfo');
        const filesList = document.getElementById('filesList');
        
        if (this.selectedFiles.length > 0) {
            selectedFilesInfo.classList.remove('hidden');
            filesList.innerHTML = this.selectedFiles.map(file => 
                `<div class="flex items-center gap-2">
                    <span class="material-symbols-outlined text-sm">image</span>
                    <span class="flex-1">${escapeHtml(file.name)}</span>
                    <span class="text-xs">${this.formatFileSize(file.size)}</span>
                </div>`
            ).join('');
        } else {
            selectedFilesInfo.classList.add('hidden');
        }
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    async uploadFiles() {
        if (this.selectedFiles.length === 0) return;
        
        const formData = new FormData();
        this.selectedFiles.forEach(file => {
            formData.append('images', file);
        });
        formData.append('path', this.currentPath);
        
        this.showUploadProgress();
        
        try {
            const response = await this.authenticatedFetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            if (!response) {
                this.hideUploadProgress();
                return; // Session expired
            }
            
            const data = await response.json();
            
            if (response.ok) {
                this.showToast(`${data.files.length} file(s) uploaded successfully`, 'success');
                this.hideUploadModal();
                this.loadFolderContents();
            } else {
                this.showToast(data.message || 'Upload failed', 'error');
            }
        } catch (error) {
            console.error('Error uploading files:', error);
            this.showToast('Upload failed', 'error');
        }
        
        this.hideUploadProgress();
    }

    showUploadProgress() {
        document.getElementById('uploadProgress').classList.remove('hidden');
        const progressFill = document.querySelector('.progress-fill');
        progressFill.style.width = '0%';
        
        // Simulate progress
        let progress = 0;
        const interval = setInterval(() => {
            progress += Math.random() * 20;
            if (progress > 90) progress = 90;
            progressFill.style.width = progress + '%';
            
            if (progress >= 90) {
                clearInterval(interval);
            }
        }, 200);
    }

    hideUploadProgress() {
        document.getElementById('uploadProgress').classList.add('hidden');
    }

    async uploadFilesDirectly(files, targetPath = this.currentPath) {
        if (files.length === 0) return;
        
        // path goes first so multer sees it before the files arrive
        const formData = new FormData();
        formData.append('path', targetPath);
        files.forEach(file => {
            formData.append('images', file);
        });

        const folderName = targetPath === 'uploads' ? 'Library' : targetPath.split('/').pop();
        this.showToast(`Uploading ${files.length} ${files.length === 1 ? 'photo' : 'photos'} to ${folderName}…`, 'info');
        
        try {
            const response = await this.authenticatedFetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            if (!response) return; // Session expired
            
            const data = await response.json();
            
            if (response.ok) {
                this.showToast(`${data.files.length} ${data.files.length === 1 ? 'photo' : 'photos'} added to ${folderName}`, 'success');
                this.loadFolderContents();
            } else {
                this.showToast(data.message || 'Upload failed', 'error');
            }
        } catch (error) {
            console.error('Error uploading files:', error);
            this.showToast('Upload failed', 'error');
        }
    }

    showContextMenu(event, item) {
        event.preventDefault();
        console.log('Context menu triggered for:', item);
        console.log('Item type:', typeof item, 'Has name:', item?.name);
        
        this.contextMenuTarget = item;
        const popover = document.getElementById('contextMenuPopover');
        
        // Show/hide menu items based on item type (data-for lists the types)
        popover.querySelectorAll('[data-for]').forEach(menuItem => {
            menuItem.style.display = menuItem.dataset.for.split(' ').includes(item.type) ? '' : 'none';
        });
        
        // Position at the right-click location, or under the options button
        const anchor = event.type === 'click' && event.currentTarget instanceof Element
            ? event.currentTarget.getBoundingClientRect()
            : null;
        const x = anchor ? anchor.right : event.clientX;
        const y = anchor ? anchor.bottom + 4 : event.clientY;
        popover.style.position = 'fixed';
        popover.style.left = (anchor ? x - popover.offsetWidth : x) + 'px';
        popover.style.top = y + 'px';
        
        // Show the popover (re-opening moves it to the new spot)
        if (!popover.matches(':popover-open')) popover.showPopover();
        
        // Adjust position if menu goes off screen
        setTimeout(() => {
            const rect = popover.getBoundingClientRect();
            if (anchor) {
                popover.style.left = Math.max(8, x - rect.width) + 'px';
                if (rect.bottom > window.innerHeight) {
                    popover.style.top = (anchor.top - rect.height - 4) + 'px';
                }
                return;
            }
            if (rect.right > window.innerWidth) {
                popover.style.left = (x - rect.width) + 'px';
            }
            if (rect.bottom > window.innerHeight) {
                popover.style.top = (y - rect.height) + 'px';
            }
        }, 0);
    }

    hideContextMenu() {
        const popover = document.getElementById('contextMenuPopover');
        if (popover.matches(':popover-open')) {
            popover.hidePopover();
        }
        this.contextMenuTarget = null;
    }

    async handleContextMenuAction(action) {
        console.log('Context menu action:', action, 'Target:', this.contextMenuTarget);
        if (!this.contextMenuTarget) return;
        
        // Store the target before hiding the menu
        const targetItem = this.contextMenuTarget;
        this.hideContextMenu();
        
        switch (action) {
            case 'delete':
                await this.deleteItem(targetItem);
                break;
            case 'rotate-right':
                await this.rotateImage(targetItem, 90);
                break;
            case 'rotate-left':
                await this.rotateImage(targetItem, -90);
                break;
            case 'create-snap':
                this.createSnap(targetItem.path);
                break;
            case 'edit-snap':
                this.openSnap(targetItem);
                break;
        }
    }

    createSnap(photoPath = null) {
        const params = new URLSearchParams({ folder: this.currentPath });
        if (photoPath) params.set('photo', photoPath);
        window.location.href = `/snap?${params}`;
    }

    async deleteItem(item) {
        console.log('Attempting to delete item:', item);
        
        if (!item || !item.name) {
            console.error('Invalid item for deletion:', item);
            this.showToast('Cannot delete: Invalid item', 'error');
            return;
        }
        
        // Show proper confirmation dialog
        const confirmDelete = await this.showDeleteConfirmation(item.name, item.type || 'image');
        if (!confirmDelete) return;
        
        try {
            const endpoint = item.type === 'folder' ? '/api/admin/folders' : '/api/images';
            console.log('Delete endpoint:', endpoint, 'Path:', item.path);
            const response = await this.authenticatedFetch(`${endpoint}?path=${encodeURIComponent(item.path)}`, {
                method: 'DELETE'
            });
            if (!response) return; // Session expired
            
            const data = await response.json();
            console.log('Delete response:', data);
            
            if (response.ok) {
                this.showToast(`${{ folder: 'Folder', snap: 'Snap' }[item.type] || 'Image'} deleted successfully`, 'success');
                this.loadFolderContents();
            } else {
                this.showToast(data.message || 'Delete failed', 'error');
            }
        } catch (error) {
            console.error('Error deleting item:', error);
            this.showToast('Delete failed', 'error');
        }
    }

    async rotateImage(item, angle = 90) {
        console.log('Attempting to rotate image:', item, 'by', angle, 'degrees');
        
        if (!item || !item.path || item.type !== 'image') {
            console.error('Invalid item for rotation:', item);
            this.showToast('Cannot rotate: Invalid item', 'error');
            return;
        }
        
        try {
            const direction = angle > 0 ? 'right' : 'left';
            this.showToast(`Rotating image ${direction}...`, 'info');
            const response = await this.authenticatedFetch('/api/images/rotate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    path: item.path,
                    angle: angle
                })
            });
            if (!response) return; // Session expired
            
            const data = await response.json();
            console.log('Rotate response:', data);
            
            if (response.ok) {
                this.showToast(`Image rotated ${direction} successfully`, 'success');
                // Force UI refresh with cache busting
                await this.refreshImageInGrid(item);
            } else {
                this.showToast(data.message || 'Rotation failed', 'error');
            }
        } catch (error) {
            console.error('Error rotating image:', error);
            this.showToast('Rotation failed', 'error');
        }
    }

    async refreshImageInGrid(item) {
        // Find the image element in the grid and refresh it with cache busting
        const imageElement = document.querySelector(`[data-path="${CSS.escape(item.path)}"] img`);
        if (imageElement) {
            // Add cache-busting timestamp to force browser to reload the image
            const timestamp = Date.now();
            const originalSrc = imageElement.src.split('?')[0]; // Remove existing query params
            imageElement.src = `${originalSrc}?t=${timestamp}`;
            
            // Also reload the folder contents to get updated metadata
            setTimeout(() => {
                this.loadFolderContents();
            }, 500); // Small delay to ensure server has processed the rotation
        } else {
            // Fallback: reload entire folder contents
            this.loadFolderContents();
        }
    }

    async checkFeatureFlags() {
        try {
            const response = await this.authenticatedFetch('/api/features');
            
            if (response && response.ok) {
                const features = await response.json();
                
                // Hide Google Photos button if disabled
                const googlePhotosBtn = document.getElementById('googlePhotosBtn');
                if (googlePhotosBtn && !features.googlePhotosEnabled) {
                    googlePhotosBtn.style.display = 'none';
                }
            }
        } catch (error) {
            console.error('Error checking feature flags:', error);
            // Hide Google Photos button on error to be safe
            const googlePhotosBtn = document.getElementById('googlePhotosBtn');
            if (googlePhotosBtn) {
                googlePhotosBtn.style.display = 'none';
            }
        }
    }

    async logout() {
        try {
            const response = await this.authenticatedFetch('/api/auth/logout', {
                method: 'POST'
            });
            
            if (response && response.ok) {
                this.showToast('Logging out...', 'info');
                setTimeout(() => {
                    window.location.href = '/login';
                }, 1000);
            } else {
                this.showToast('Logout failed', 'error');
            }
        } catch (error) {
            console.error('Error during logout:', error);
            this.showToast('Logout failed', 'error');
        }
    }

    showToast(message, type = 'info') {
        showToast(message, type);
    }

    showPhotoModal(imageUrl, imageName) {
        const modal = document.getElementById('photoModal');
        const modalImage = document.getElementById('modalImage');
        
        // Find current image index
        this.currentImageIndex = this.availableImages.findIndex(img => img.url === imageUrl);
        
        modalImage.src = imageUrl;
        modalImage.alt = imageName;
        
        // Reset zoom state
        modalImage.classList.remove('zoomed');
        modalImage.style.transform = '';
        this.isZoomed = false;
        this.dragState = { isDragging: false, startX: 0, startY: 0, translateX: 0, translateY: 0 };
        
        // Add event listeners for zoom and pan
        this.setupPhotoModalInteractions(modalImage);
        
        modal.showModal();
    }

    hidePhotoModal() {
        const modal = document.getElementById('photoModal');
        modal.close();
        
        // Clear the image and reset state
        const modalImage = document.getElementById('modalImage');
        modalImage.src = '';
        modalImage.classList.remove('zoomed');
        modalImage.style.transform = '';
        this.isZoomed = false;
        
        // Remove event listeners
        this.cleanupPhotoModalInteractions(modalImage);
    }

    setupPhotoModalInteractions(modalImage) {
        // Click to zoom
        this.photoClickHandler = (e) => {
            e.stopPropagation();
            this.togglePhotoZoom(modalImage);
        };
        
        // Mouse drag for panning when zoomed
        this.photoMouseDownHandler = (e) => {
            if (!this.isZoomed) return;
            this.startPhotoDrag(e, modalImage);
        };
        
        this.photoMouseMoveHandler = (e) => {
            this.handlePhotoDrag(e, modalImage);
        };
        
        this.photoMouseUpHandler = () => {
            this.endPhotoDrag();
        };
        
        // Touch events for mobile
        this.photoTouchStartHandler = (e) => {
            if (!this.isZoomed) return;
            this.startPhotoDrag(e.touches[0], modalImage);
        };
        
        this.photoTouchMoveHandler = (e) => {
            if (this.dragState.isDragging) {
                e.preventDefault();
                this.handlePhotoDrag(e.touches[0], modalImage);
            }
        };
        
        this.photoTouchEndHandler = () => {
            this.endPhotoDrag();
        };
        
        // Add event listeners
        modalImage.addEventListener('click', this.photoClickHandler);
        modalImage.addEventListener('mousedown', this.photoMouseDownHandler);
        document.addEventListener('mousemove', this.photoMouseMoveHandler);
        document.addEventListener('mouseup', this.photoMouseUpHandler);
        modalImage.addEventListener('touchstart', this.photoTouchStartHandler, { passive: true });
        document.addEventListener('touchmove', this.photoTouchMoveHandler, { passive: false });
        document.addEventListener('touchend', this.photoTouchEndHandler);
    }

    cleanupPhotoModalInteractions(modalImage) {
        if (this.photoClickHandler) modalImage.removeEventListener('click', this.photoClickHandler);
        if (this.photoMouseDownHandler) modalImage.removeEventListener('mousedown', this.photoMouseDownHandler);
        if (this.photoMouseMoveHandler) document.removeEventListener('mousemove', this.photoMouseMoveHandler);
        if (this.photoMouseUpHandler) document.removeEventListener('mouseup', this.photoMouseUpHandler);
        if (this.photoTouchStartHandler) modalImage.removeEventListener('touchstart', this.photoTouchStartHandler);
        if (this.photoTouchMoveHandler) document.removeEventListener('touchmove', this.photoTouchMoveHandler);
        if (this.photoTouchEndHandler) document.removeEventListener('touchend', this.photoTouchEndHandler);
    }

    togglePhotoZoom(modalImage) {
        this.isZoomed = !this.isZoomed;
        
        if (this.isZoomed) {
            modalImage.classList.add('zoomed');
            modalImage.style.cursor = 'move';
        } else {
            modalImage.classList.remove('zoomed');
            modalImage.style.cursor = 'zoom-in';
            modalImage.style.transform = '';
            this.dragState.translateX = 0;
            this.dragState.translateY = 0;
        }
    }

    startPhotoDrag(event, modalImage) {
        if (!this.isZoomed) return;
        
        this.dragState.isDragging = true;
        this.dragState.startX = event.clientX - this.dragState.translateX;
        this.dragState.startY = event.clientY - this.dragState.translateY;
        modalImage.style.cursor = 'grabbing';
    }

    handlePhotoDrag(event, modalImage) {
        if (!this.dragState.isDragging || !this.isZoomed) return;
        
        this.dragState.translateX = event.clientX - this.dragState.startX;
        this.dragState.translateY = event.clientY - this.dragState.startY;
        
        modalImage.style.transform = `scale(1.5) translate(${this.dragState.translateX}px, ${this.dragState.translateY}px)`;
    }

    endPhotoDrag() {
        if (this.dragState.isDragging) {
            this.dragState.isDragging = false;
            const modalImage = document.getElementById('modalImage');
            if (modalImage && this.isZoomed) {
                modalImage.style.cursor = 'move';
            }
        }
    }

    // Long Press Detection Methods
    handlePointerDown(e, file, element) {
        this.longPressTriggered = false;
        element.classList.add('selecting');
        
        this.longPressTimeout = setTimeout(() => {
            this.longPressTriggered = true;
            element.classList.remove('selecting');
            this.toggleSelection(file);
            // Add haptic feedback on mobile
            if (navigator.vibrate) {
                navigator.vibrate(50);
            }
        }, this.longPressDelay);
        
        // Mouse presses must stay default so the tile can be dragged
        if (e.type === 'touchstart') e.preventDefault();
    }

    handlePointerUp(_e, _file, element) {
        this.cancelLongPress();
        element.classList.remove('selecting');
    }

    cancelLongPress() {
        if (this.longPressTimeout) {
            clearTimeout(this.longPressTimeout);
            this.longPressTimeout = null;
        }
    }


    // Selection Management Methods
    toggleSelection(file) {
        const filePath = file.path;
        const fileElement = document.querySelector(`[data-path="${filePath}"]`);
        const checkbox = fileElement.querySelector('input[type="checkbox"]');
        
        if (this.selectedItems.has(filePath)) {
            this.selectedItems.delete(filePath);
            fileElement.classList.remove('selected');
            checkbox.checked = false;
        } else {
            this.selectedItems.add(filePath);
            fileElement.classList.add('selected');
            checkbox.checked = true;
        }
        
        this.updateSelectionUI();
    }

    clearSelection() {
        this.selectedItems.forEach(filePath => {
            const fileElement = document.querySelector(`[data-path="${filePath}"]`);
            if (fileElement) {
                const checkbox = fileElement.querySelector('input[type="checkbox"]');
                fileElement.classList.remove('selected');
                if (checkbox) {
                    checkbox.checked = false;
                }
            }
        });
        
        this.selectedItems.clear();
        this.updateSelectionUI();
    }

    updateSelectionUI() {
        const selectionCount = this.selectedItems.size;
        const fabBadge = document.getElementById('fabBadge');
        const selectionFab = document.getElementById('selectionFab');
        const currentCount = parseInt(fabBadge.textContent) || 0;
        
        // Update badge text
        fabBadge.textContent = selectionCount;
        
        // Add bounce animation if count changed
        if (selectionCount !== currentCount && selectionCount > 0) {
            fabBadge.classList.remove('updated');
            // Force reflow to restart animation
            fabBadge.offsetHeight;
            fabBadge.classList.add('updated');
            
            // Remove animation class after animation completes
            setTimeout(() => {
                fabBadge.classList.remove('updated');
            }, 600);
        }
        
        // Show/hide FAB with smooth animation
        if (selectionCount > 0) {
            selectionFab.classList.remove('hidden');
        } else {
            selectionFab.classList.add('hidden');
        }
    }

    showBulkDeleteModal() {
        if (this.selectedItems.size === 0) return;
        
        const modal = document.getElementById('bulkDeleteModal');
        const deleteCountElement = document.getElementById('deleteCount');
        
        deleteCountElement.textContent = this.selectedItems.size;
        modal.showModal();
    }

    hideBulkDeleteModal() {
        const modal = document.getElementById('bulkDeleteModal');
        modal.close();
    }

    async confirmBulkDelete() {
        const selectedPaths = Array.from(this.selectedItems);
        
        if (selectedPaths.length === 0) {
            this.hideBulkDeleteModal();
            return;
        }
        
        try {
            this.showToast('Deleting photos...', 'info');
            
            const response = await this.authenticatedFetch('/api/images/batch', {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    paths: selectedPaths
                })
            });
            
            if (!response) return; // Session expired
            
            const data = await response.json();
            
            if (response.ok) {
                this.showToast(`Successfully deleted ${data.deletedCount} photos`, 'success');
                this.clearSelection();
                this.loadFolderContents(); // Refresh the grid
            } else {
                console.error('Bulk delete failed:', data);
                this.showToast(data.message || 'Failed to delete photos', 'error');
            }
        } catch (error) {
            console.error('Error during bulk delete:', error);
            this.showToast('Failed to delete photos', 'error');
        } finally {
            this.hideBulkDeleteModal();
        }
    }

    // Enhanced confirmation dialog for single item deletion
    async showDeleteConfirmation(itemName, itemType = 'image') {
        const itemLabel = { folder: 'Folder', snap: 'Snap' }[itemType] || 'Photo';
        return new Promise((resolve) => {
            // Create a custom confirmation dialog
            const dialogHtml = `
                <dialog id="deleteConfirmModal" class="dialog" aria-labelledby="delete-confirm-title">
                    <article>
                        <header>
                            <h2 id="delete-confirm-title">Delete ${itemLabel}</h2>
                        </header>
                        <section>
                            <p>Are you sure you want to delete <strong>"${itemName}"</strong>?</p>
                            <p class="text-sm text-destructive mt-2">This action cannot be undone.</p>
                        </section>
                        <footer>
                            <button id="cancelSingleDeleteBtn" class="btn-outline">Cancel</button>
                            <button id="confirmSingleDeleteBtn" class="btn-destructive">
                                <span class="material-symbols-outlined">delete</span>
                                Delete ${itemLabel}
                            </button>
                        </footer>
                    </article>
                </dialog>
            `;
            
            // Remove existing modal if present
            const existing = document.getElementById('deleteConfirmModal');
            if (existing) {
                existing.remove();
            }
            
            // Add new modal to body
            document.body.insertAdjacentHTML('beforeend', dialogHtml);
            const modal = document.getElementById('deleteConfirmModal');
            
            // Event handlers
            const cancelBtn = document.getElementById('cancelSingleDeleteBtn');
            const confirmBtn = document.getElementById('confirmSingleDeleteBtn');
            
            const cleanup = () => {
                modal.close();
                setTimeout(() => modal.remove(), 200);
            };
            
            cancelBtn.addEventListener('click', () => {
                cleanup();
                resolve(false);
            });
            
            confirmBtn.addEventListener('click', () => {
                cleanup();
                resolve(true);
            });
            
            // Close on backdrop click
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    cleanup();
                    resolve(false);
                }
            });
            
            // Show modal
            modal.showModal();
        });
    }

    // Empty state upload methods
    setupEmptyStateDragAndDrop() {
        const dropZone = document.getElementById('emptyStateUploadZone');
        
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            
            const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
            this.handleEmptyStateFileSelection(files);
        });
    }

    handleEmptyStateFileSelection(files) {
        this.emptyStateSelectedFiles = files.filter(file => file.type.startsWith('image/'));
        this.updateEmptyStateUploadButton();
        this.updateEmptyStateFilesDisplay();
    }

    updateEmptyStateUploadButton() {
        const btn = document.getElementById('emptyStateUploadBtn');
        const btnText = document.getElementById('emptyStateUploadBtnText');
        const cancelBtn = document.getElementById('emptyStateCancelBtn');
        
        btn.disabled = !this.emptyStateSelectedFiles || this.emptyStateSelectedFiles.length === 0;
        
        if (this.emptyStateSelectedFiles && this.emptyStateSelectedFiles.length > 0) {
            btnText.textContent = `Upload ${this.emptyStateSelectedFiles.length} file${this.emptyStateSelectedFiles.length > 1 ? 's' : ''}`;
            cancelBtn.classList.remove('hidden');
        } else {
            btnText.textContent = 'Select Files';
            cancelBtn.classList.add('hidden');
        }
    }

    updateEmptyStateFilesDisplay() {
        const selectedFilesDiv = document.getElementById('emptyStateSelectedFiles');
        const filesList = document.getElementById('emptyStateFilesList');
        
        if (this.emptyStateSelectedFiles && this.emptyStateSelectedFiles.length > 0) {
            selectedFilesDiv.classList.remove('hidden');
            filesList.innerHTML = this.emptyStateSelectedFiles.map(file => 
                `<div class="flex items-center gap-2">
                    <span class="material-symbols-outlined text-sm">image</span>
                    <span class="flex-1">${escapeHtml(file.name)}</span>
                    <span class="text-xs">${this.formatFileSize(file.size)}</span>
                </div>`
            ).join('');
        } else {
            selectedFilesDiv.classList.add('hidden');
        }
    }

    async uploadEmptyStateFiles() {
        if (!this.emptyStateSelectedFiles || this.emptyStateSelectedFiles.length === 0) return;
        
        const formData = new FormData();
        this.emptyStateSelectedFiles.forEach(file => {
            formData.append('images', file);
        });
        formData.append('path', this.currentPath);
        
        this.showEmptyStateUploadProgress();
        
        try {
            const response = await this.authenticatedFetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            if (!response) {
                this.hideEmptyStateUploadProgress();
                return; // Session expired
            }
            
            const data = await response.json();
            
            if (response.ok) {
                this.showToast(`${data.files.length} file(s) uploaded successfully`, 'success');
                this.resetEmptyStateUpload();
                this.loadFolderContents(); // This will hide the empty state and show the uploaded files
            } else {
                this.showToast(data.message || 'Upload failed', 'error');
            }
        } catch (error) {
            console.error('Error uploading files:', error);
            this.showToast('Upload failed', 'error');
        }
        
        this.hideEmptyStateUploadProgress();
    }

    showEmptyStateUploadProgress() {
        document.getElementById('emptyStateUploadProgress').classList.remove('hidden');
        const progressFill = document.querySelector('.empty-state-progress-fill');
        progressFill.style.width = '0%';
        
        // Simulate progress
        let progress = 0;
        const interval = setInterval(() => {
            progress += Math.random() * 20;
            if (progress > 90) progress = 90;
            progressFill.style.width = progress + '%';
            
            if (progress >= 90) {
                clearInterval(interval);
            }
        }, 200);
    }

    hideEmptyStateUploadProgress() {
        document.getElementById('emptyStateUploadProgress').classList.add('hidden');
    }

    resetEmptyStateUpload() {
        this.emptyStateSelectedFiles = [];
        document.getElementById('emptyStateFileInput').value = '';
        this.updateEmptyStateUploadButton();
        this.updateEmptyStateFilesDisplay();
        this.hideEmptyStateUploadProgress();
    }

    // Photo modal navigation methods
    navigateToNextImage() {
        if (this.availableImages.length === 0 || this.currentImageIndex === -1) return;
        
        const nextIndex = (this.currentImageIndex + 1) % this.availableImages.length;
        this.navigateToImageAtIndex(nextIndex);
    }

    navigateToPreviousImage() {
        if (this.availableImages.length === 0 || this.currentImageIndex === -1) return;
        
        const prevIndex = this.currentImageIndex === 0 
            ? this.availableImages.length - 1 
            : this.currentImageIndex - 1;
        this.navigateToImageAtIndex(prevIndex);
    }

    navigateToImageAtIndex(index) {
        if (index < 0 || index >= this.availableImages.length) return;
        
        const image = this.availableImages[index];
        const modalImage = document.getElementById('modalImage');
        
        this.currentImageIndex = index;
        modalImage.src = image.url;
        modalImage.alt = image.name;
        
        // Reset zoom state when navigating
        modalImage.classList.remove('zoomed');
        modalImage.style.transform = '';
        modalImage.style.cursor = 'zoom-in';
        this.isZoomed = false;
        this.dragState = { isDragging: false, startX: 0, startY: 0, translateX: 0, translateY: 0 };
    }

}

// Initialize the admin panel when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.photoFrameAdmin = new PhotoFrameAdmin();
});
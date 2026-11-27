/**
 * Page-wide toast via Basecoat, shared by admin.js, settings.js and googlePhotosSync.js.
 */
const toastTitle = (category) => ({
    success: t('admin.toastSuccess'),
    error: t('admin.toastError'),
    warning: t('admin.toastWarning'),
    info: t('admin.toastInfo')
})[category];

// In front of open dialogs and the phone's tab bar (js/toastLayer.js)
function raiseToaster() {
    const toaster = document.getElementById('toaster');
    if (!toaster || !window.SoraToastLayer) return;
    if (!toaster.dataset.followed) {
        toaster.dataset.followed = 'true';
        window.SoraToastLayer.follow(toaster);
    }
    window.SoraToastLayer.raise(toaster);
}

// Basecoat puts the description in as HTML: messages can hold a folder's name or
// the server's words, so they go in as text
function showToast(message, type = 'info') {
    const category = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info';
    raiseToaster();
    document.dispatchEvent(new CustomEvent('basecoat:toast', {
        detail: {
            config: { category, title: toastTitle(category), description: escapeHtml(message), duration: 5000 }
        }
    }));
}
window.showToast = showToast;

function escapeHtml(value) {
    // Quotes too, so the result is also safe inside an attribute (data-folder="...")
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Drag payload for photos moved inside the library (a JSON list of admin paths)
// Some browsers give HEIC photos no type, so the name decides
const isImageFile = (file) => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name);

const PHOTO_DRAG_TYPE = 'application/x-sora-photos';

const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
const isPhotoDrag = (e) => Array.from(e.dataTransfer?.types || []).includes(PHOTO_DRAG_TYPE);

class PhotoFrameAdmin {
    constructor() {
        this.currentPath = this.getInitialPath();
        this.selectedFiles = [];
        this.emptyStateSelectedFiles = []; // For empty state upload
        // Selection mode (js/selectionMode.js): a tick or a long press starts it, and
        // Escape, Cancel or the phone's Back ends it
        this.selection = SoraSelection.create({ history: window.history, onChange: () => this.updateSelectionUI() });
        this.measured = new Map(); // path -> { width, height } of photos measured as they loaded
        this.contextMenuTarget = null;
        this.longPressDelay = 500; // 500ms for long press
        
        // Photo modal zoom/pan state
        this.isZoomed = false;
        this.dragState = { isDragging: false, startX: 0, startY: 0, translateX: 0, translateY: 0 };
        
        // Photo modal navigation state
        this.currentImageUrl = null; // the photo open in the viewer, kept by identity across refreshes
        this.currentImageSlot = -1; // its last position, to land nearby if it disappears
        this.availableImages = [];
        
        this.initializeEventListeners();
        window.addEventListener('sora:languagechange', () => this.onLanguageChange());
        this.updateURL(); // Ensure URL reflects current path
        this.loadFolderContents();
        this.takeSharedPhotos();
    }

    // Someone a library is shared with "can view" only: no uploads, moves,
    // deletes or edits (js/scope.js hides those controls; the server refuses them)
    canEdit() {
        return !window.SoraScope || window.SoraScope.canEdit();
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
        raiseToaster();
        document.dispatchEvent(new CustomEvent('basecoat:toast', {
            detail: {
                config: {
                    category: 'error',
                    title: t('admin.sessionExpiredTitle'),
                    description: escapeHtml(t('admin.sessionExpired')),
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

    // Each folder opened is a history entry, so the phone's Back button goes up
    // a folder instead of leaving the library. push: a new entry, else the
    // current one is corrected in place (first load, or Back itself).
    updateURL(push = false) {
        const url = new URL(window.location);
        if (this.currentPath === 'uploads') {
            url.searchParams.delete('path');
        } else {
            url.searchParams.set('path', this.currentPath);
        }
        if (url.href === location.href) return;
        if (push) window.history.pushState({}, '', url);
        else {
            // Selection's own entry, taken over by the folder that opens from it
            const { selecting, ...state } = history.state || {};
            window.history.replaceState(state, '', url);
        }
    }

    // Back and Forward: close the photo viewer first, then show the folder the
    // entry is for
    handleHistory() {
        // Back while photos are selected ends selection first
        this.selection.onPopState(history.state);
        const modal = document.getElementById('photoModal');
        if (modal.open && !history.state?.photo) this.hidePhotoModal();
        const path = this.getInitialPath();
        if (path !== this.currentPath) {
            this.currentPath = path;
            this.loadFolderContents();
        }
    }

    initializeEventListeners() {
        // Navigation
        document.getElementById('backBtn').addEventListener('click', () => this.navigateBack());
        window.addEventListener('popstate', () => this.handleHistory());
        
        // Breadcrumb navigation
        document.getElementById('breadcrumbContainer').addEventListener('click', (e) => {
            if (e.target.classList.contains('breadcrumb-item')) {
                this.navigateTo(e.target.dataset.path);
            }
        });

        // Create folder
        document.getElementById('createFolderBtn').addEventListener('click', () => this.showCreateFolderModal());
        document.getElementById('createSnapBtn').addEventListener('click', () => this.createSnap());
        document.getElementById('createNoteBtn').addEventListener('click', () => this.createNote());
        document.getElementById('playOrderSelect').addEventListener('change', (e) => this.setPlayOrder(e.target.value));
        document.getElementById('confirmCreateBtn').addEventListener('click', () => this.createFolder());
        document.getElementById('cancelCreateBtn').addEventListener('click', () => this.hideCreateFolderModal());
        document.getElementById('closeCreateFolderModal').addEventListener('click', () => this.hideCreateFolderModal());

        // Upload
        // Upload opens the add menu, or the upload dialog when it's the only choice (js/addMenu.js)
        document.getElementById('closeUploadModal').addEventListener('click', () => this.hideUploadModal());
        
        // Log out and the theme button are the shared header's (js/appHeader.js)

        document.getElementById('confirmUploadBtn').addEventListener('click', () => this.uploadFiles());
        document.getElementById('cancelUploadBtn').addEventListener('click', () => this.hideUploadModal());
        document.getElementById('uploadDropZone').addEventListener('click', () => document.getElementById('fileInput').click());

        // File input
        document.getElementById('fileInput').addEventListener('change', (e) => {
            if (this.uploading) return; // the photos on their way stay the ones shown
            this.selectedFiles = Array.from(e.target.files);
            this.showUploadError(null);
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
            if (e.button === 0 && !e.target.closest('#contextMenuPopover, .folder-more, .photo-more, #selectionMoreBtn')) {
                this.hideContextMenu({ returnFocus: false }); // focus goes where the click was
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const menuOpen = document.getElementById('contextMenuPopover').matches(':popover-open')
                || Boolean(document.getElementById('addMenu')?.matches(':popover-open'));
            this.hideContextMenu();
            // Escape closes what's on top first: a menu or a dialog, then selection
            if (!menuOpen && !document.querySelector('dialog[open]')) this.selection.onKey(e);
        });
        document.getElementById('contextMenuPopover').addEventListener('keydown', (e) => this.contextMenuKey(e));
        window.addEventListener('resize', () => this.hideContextMenu());
        // Scrolling the page moves the menu's anchor away; scrolling a long menu itself doesn't
        document.addEventListener('scroll', (e) => {
            if (e.target instanceof Element && e.target.closest('#contextMenuPopover')) return;
            this.hideContextMenu();
        }, { capture: true, passive: true });
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
        document.getElementById('photoModalPrev').addEventListener('click', () => this.navigateToPreviousImage());
        document.getElementById('photoModalNext').addEventListener('click', () => this.navigateToNextImage());
        document.getElementById('photoModal').addEventListener('close', () => {
            if (history.state?.photo) history.back();
        });
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
                    // Arrows follow the reading direction, like the on-screen
                    // buttons: in right-to-left languages Left is next
                    case 'ArrowLeft':
                    case 'ArrowRight': {
                        e.preventDefault();
                        const rtl = document.documentElement.dir === 'rtl';
                        if ((e.key === 'ArrowRight') !== rtl) this.navigateToNextImage();
                        else this.navigateToPreviousImage();
                        break;
                    }
                }
            }
        });

        // Selection bar: Delete, Move, Select all, the one photo's menu, and Cancel
        document.getElementById('bulkDeleteBtn').addEventListener('click', () => this.showBulkDeleteModal());
        document.getElementById('bulkMoveBtn').addEventListener('click', () => this.openMoveDialog(this.selection.keys()));
        document.getElementById('selectAllBtn').addEventListener('click', () => this.selectAll());
        document.getElementById('clearSelectionBtn').addEventListener('click', () => this.clearSelection());
        document.getElementById('selectionMoreBtn').addEventListener('click', (e) => {
            const [only] = this.selection.keys();
            const file = this.folderData?.files.find(item => item.path === only);
            if (file) this.showContextMenu(e, { ...file, type: this.tileType(file) });
        });

        // Move to…: a folder picker (see openMoveDialog)
        document.getElementById('moveHereBtn').addEventListener('click', () => this.confirmMove());
        document.getElementById('cancelMoveBtn').addEventListener('click', () => document.getElementById('moveDialog').close());
        document.getElementById('moveUpBtn').addEventListener('click', () => this.showMoveFolder(this.moveParent()));
        document.getElementById('moveDialog').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.close();
            const folder = e.target.closest('.move-folder');
            if (folder) this.showMoveFolder(folder.dataset.path);
        });

        // The photo grid lays itself out again when its width changes
        if (window.ResizeObserver) {
            new ResizeObserver(() => this.scheduleLayout()).observe(document.getElementById('fileGrid'));
        }
        
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
            if (e.target.closest('#openSessionBtn') && window.googlePhotosSync) {
                window.googlePhotosSync.openPickerSession();
            }
            if (e.target.id === 'retrySessionBtn' && window.googlePhotosSync) {
                window.googlePhotosSync.createPickerSession();
            }
        });
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
            
            if (this.uploading) return;
            const files = Array.from(e.dataTransfer.files).filter(isImageFile);
            this.selectedFiles = files;
            this.showUploadError(null);
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
        if (!this.canEdit()) return;
        const files = Array.from(e.dataTransfer.files).filter(isImageFile);
        if (files.length > 0) {
            this.uploadFilesDirectly(files, targetPath);
        } else {
            this.showToast(t('admin.onlyImages'), 'warning');
        }
    }

    moveDroppedPhotos(e, destination) {
        if (!this.canEdit()) return;
        let paths = [];
        try {
            paths = JSON.parse(e.dataTransfer.getData(PHOTO_DRAG_TYPE));
        } catch {
            return;
        }
        if (Array.isArray(paths) && paths.length > 0) this.movePhotos(paths, destination);
    }

    async movePhotos(paths, destination) {
        const folderName = this.folderDisplayName(destination);
        try {
            const response = await this.authenticatedFetch('/api/images/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths, destination })
            });
            if (!response) return; // Session expired

            const data = await response.json();
            if (!response.ok && response.status !== 207) {
                this.showToast(i18n.error(data, 'admin.moveFailed'), 'error');
                return;
            }

            const moved = data.movedCount || 0;
            if (moved > 0) {
                this.showToast(t('admin.movedTo', { count: moved, name: folderName }), 'success');
            }
            if (data.failedCount > 0) {
                this.showToast(t('admin.moveFailedCount', { count: data.failedCount }), 'error');
            }
            this.loadFolderContents();
        } catch (error) {
            console.error('Error moving photos:', error);
            this.showToast(t('admin.moveFailed'), 'error');
        }
    }

    async loadFolderContents() {
        this.clearSelection(); // Clear selection when navigating
        
        // Only the latest request may draw the grid: a slow answer for a folder
        // the user has already left must not replace what is on screen (or the
        // photo open in the viewer)
        const request = this.folderRequest = (this.folderRequest || 0) + 1;
        const path = this.currentPath;
        const isCurrent = () => request === this.folderRequest && path === this.currentPath;
        // Until this folder's listing says whether it may hold new folders (it may be
        // at MAX_FOLDER_DEPTH), "New folder" can't be used
        this.setCreateFolder('pending');

        try {
            const response = await this.authenticatedFetch(`/api/admin/folders?path=${encodeURIComponent(path)}`);
            if (!response) return; // Session expired, handled by authenticatedFetch
            
            const data = await response.json();
            if (!isCurrent()) return;
            
            if (response.ok) {
                this.setCreateFolder(data.canCreateFolder === false ? 'refused' : 'allowed');
                this.renderFolderContents(data);
                this.updateBreadcrumb();
                this.updateBackButton();
            } else if (response.status === 404 && path !== 'uploads') {
                // Gone, or not one this person can see (an old link, say): back
                // to the top of the library rather than an empty page
                this.showToast(t('errors.FOLDER_NOT_FOUND'), 'error');
                this.currentPath = 'uploads';
                this.updateURL();
                this.loadFolderContents();
            } else {
                this.setCreateFolder(this.knownCreateFolder(path));
                this.showToast(i18n.error(data, 'admin.loadFolderFailed'), 'error');
            }
        } catch (error) {
            if (!isCurrent()) return;
            this.setCreateFolder(this.knownCreateFolder(path));
            console.error('Error loading folder contents:', error);
            this.showToast(t('admin.loadFolderFailed'), 'error');
        }
    }

    // "New folder" for the folder being opened: 'pending' while its listing loads,
    // then 'allowed', or 'refused' at MAX_FOLDER_DEPTH. Set only when a listing
    // answers, so redrawing a cached one (a language change) can't turn it back on.
    setCreateFolder(state) {
        const button = document.getElementById('createFolderBtn');
        button.disabled = state !== 'allowed';
        if (state !== 'pending') {
            button.classList.toggle('hidden', state === 'refused');
            (this.createFolderKnown = this.createFolderKnown || new Map()).set(this.currentPath, state);
        }
    }

    // A listing that failed: what an earlier one said about this folder (a refresh
    // after an upload, or a folder opened before); otherwise offered, as the server still checks
    knownCreateFolder(path) {
        return (this.createFolderKnown && this.createFolderKnown.get(path)) || 'allowed';
    }

    renderFolderContents(data) {
        const fileGrid = document.getElementById('fileGrid');
        const emptyState = document.getElementById('emptyState');

        // Redrawing replaces every tile: focus on one (its options button after a
        // Rotate from the menu, say) goes to the same photo's new tile
        const focused = document.activeElement;
        const focusTile = focused && fileGrid.contains(focused) ? focused.closest('.file-item') : null;
        const focusPath = focusTile?.dataset.path;
        const focusPart = focusTile && ['.photo-more', '.folder-more', '.tile-open'].find(part => focused.matches(part));

        fileGrid.innerHTML = '';
        this.folderData = data; // kept to redraw the grid when the language changes

        // Update available images for navigation
        // Snaps and notes open in their own editors, so the photo viewer steps over them
        this.availableImages = data.files.filter(file => file.type !== 'snap' && file.type !== 'note').map((file, index) => ({
            ...file,
            index: index
        }));
        this.updatePhotoModalNav();

        this.updateLibraryHeading(data);
        // A folder that only leads to the ones shared with this person: look, don't add
        document.documentElement?.classList.toggle('read-only-folder', data.canChange === false);
        this.playOrder = data.order || 'shuffle';
        this.fileNames = data.files.map(file => file.name);
        this.showPlayOrder();
        // MAX_FOLDER_DEPTH: no "New folder" in a folder at the deepest level

        // Background hint under the grid; the empty state has its own upload box
        const isEmpty = data.folders.length === 0 && data.files.length === 0;
        document.getElementById('dropHint').classList.toggle('hidden', isEmpty);
        this.renderDropTexts();
        document.getElementById('dropHintMove').classList.toggle('hidden', !(data.folders.length && data.files.length));

        this.photoFiles = [];
        this.tiles = new Map();
        this.photoArea = null;
        if (isEmpty) {
            emptyState.classList.remove('hidden');
            return;
        }

        emptyState.classList.add('hidden');

        // Folders first, as cards, with the Google Photos import card when it's connected
        const importCard = window.googlePhotosSync && window.googlePhotosSync.isAuthenticated;
        if (data.folders.length > 0 || importCard) {
            if (data.folders.length > 0) fileGrid.appendChild(this.createGridLabel(t('admin.gridFolders')));
            const folders = document.createElement('div');
            folders.className = 'folder-grid';
            if (importCard) folders.appendChild(this.createGooglePhotosImportElement());
            data.folders.forEach(folder => folders.appendChild(this.createFolderElement(folder)));
            fileGrid.appendChild(folders);
        }

        // Then the photos, in rows that keep each one's shape (layoutPhotos)
        if (data.files.length > 0) {
            this.photoFiles = data.files.slice();
            data.files.forEach(file => this.tiles.set(file.path, this.createFileElement(file)));
            const groups = this.photoGroups();
            // "Photos" under the folders, unless dates head the photos
            if (data.folders.length > 0 && !groups.some(group => group.label)) {
                fileGrid.appendChild(this.createGridLabel(t('admin.gridPhotos')));
            }
            const area = document.createElement('div');
            area.className = 'photo-area';
            area.id = 'photoArea';
            fileGrid.appendChild(area);
            this.photoArea = area;
            this.layoutPhotos();
        }
        this.updateSelectionUI();

        if (focusPath !== undefined) {
            const tile = [...fileGrid.querySelectorAll('.file-item')].find(item => item.dataset.path === focusPath);
            const target = tile && ((focusPart && tile.querySelector(focusPart)) || tile.querySelector('.photo-more, .folder-more'));
            target?.focus({ preventScroll: true });
        }
    }

    // ---------- The photo grid: justified rows, grouped by date -----------

    // What a tile is: an image, or a snap or note (drawn pages)
    tileType(file) {
        return file.type === 'snap' || file.type === 'note' ? file.type : 'image';
    }

    // A photo's shape for the rows: from the listing, or measured as it loaded.
    // Snaps and notes are pages in the frame's landscape shape.
    shapeOf(file) {
        if (file.type === 'snap' || file.type === 'note') return 4 / 3;
        if (file.width > 0 && file.height > 0) return { width: file.width, height: file.height };
        return this.measured.get(file.path) || null;
    }

    // Newest or oldest first: grouped by month (by day when they're all in one
    // month). Shuffle and My order keep one list, in the order the folder has.
    photoGroups() {
        const files = this.photoFiles || [];
        if (this.playOrder !== 'newest' && this.playOrder !== 'oldest') return [{ label: null, files }];
        return SoraJustified.groupByDate(files, { locale: (window.i18n && window.i18n.locale) || 'en' });
    }

    // Lay the photos out in rows as wide as the grid (js/justifiedLayout.js). The
    // tiles are made once per listing and moved into the new rows each time.
    layoutPhotos() {
        const area = this.photoArea;
        if (!area || !this.tiles) return;
        const width = Math.floor(area.getBoundingClientRect().width || area.clientWidth || 0) || 1200;
        const gap = width < 640 ? 3 : 4;
        const rowHeight = SoraJustified.rowHeightFor(width);
        area.style.setProperty('--grid-gap', `${gap}px`);
        const sections = this.photoGroups().map(group => {
            const section = document.createElement('section');
            section.className = 'photo-group';
            if (group.label) {
                const heading = document.createElement('h2');
                heading.className = 'photo-group-title';
                const label = document.createElement('span');
                label.textContent = group.label;
                const count = document.createElement('span');
                count.className = 'photo-group-count';
                count.textContent = t('admin.countPhotos', { count: group.files.length });
                heading.appendChild(label);
                heading.appendChild(count);
                section.appendChild(heading);
            }
            const { rows } = SoraJustified.layout(group.files.map(file => this.shapeOf(file)), { width, rowHeight, gap });
            rows.forEach(row => {
                const line = document.createElement('div');
                line.className = 'photo-row';
                line.style.height = `${row.height}px`;
                row.items.forEach(item => {
                    const tile = this.tiles.get(group.files[item.index].path);
                    if (!tile) return;
                    tile.style.width = `${item.width}px`;
                    tile.style.height = `${row.height}px`;
                    line.appendChild(tile);
                });
                section.appendChild(line);
            });
            return section;
        });
        area.replaceChildren(...sections);
        this.layoutWidth = width;
    }

    // Again on the next frame, once (a width change, a photo measured as it loaded)
    scheduleLayout() {
        if (this.layoutQueued) return;
        this.layoutQueued = true;
        requestAnimationFrame(() => {
            this.layoutQueued = false;
            const area = this.photoArea;
            if (!area) return;
            const width = Math.floor(area.getBoundingClientRect().width);
            if (width !== this.layoutWidth || this.layoutStale) {
                this.layoutStale = false;
                this.layoutPhotos();
            }
        });
    }

    // The library root shows as "Library"; any other folder by its own name
    folderDisplayName(path) {
        return path === 'uploads' ? t('common.library') : path.split('/').pop();
    }

    // "Drop … to add them to <folder>": whole sentences, the folder name dropped into {name}
    renderDropTexts() {
        const name = `<strong class="drop-folder-name">${escapeHtml(this.folderDisplayName(this.currentPath))}</strong>`;
        const zone = document.getElementById('dropZoneText');
        const hint = document.getElementById('dropHintText');
        if (zone) zone.innerHTML = t('admin.dropToAdd', { name });
        if (hint) hint.innerHTML = t('admin.dropHint', { name });
    }

    // Redraw what this script wrote, after i18n.apply() has re-translated the static page
    onLanguageChange() {
        this.updateUploadButton();
        this.updateEmptyStateUploadButton();
        if (!this.folderData) return;
        // The tiles are drawn again; what was selected stays selected
        this.renderFolderContents(this.folderData);
        this.updateBreadcrumb();
    }

    updateLibraryHeading(data) {
        const parts = this.currentPath.split('/');
        const title = document.getElementById('folderTitle');
        const meta = document.getElementById('folderMeta');

        if (title) title.textContent = parts.length > 1 ? parts[parts.length - 1] : t('common.library');
        // "All notes" beside the counts when this folder has notes; the Notes page
        // it opens starts new notes in this folder
        const allNotes = document.getElementById('allNotesLink');
        if (allNotes) {
            allNotes.href = this.currentPath === 'uploads' ? '/notes' : `/notes?folder=${encodeURIComponent(this.currentPath)}`;
            allNotes.classList.toggle('hidden', !data.files.some(file => file.type === 'note'));
        }
        if (meta) {
            const folders = data.folders.length;
            const snaps = data.files.filter(file => file.type === 'snap').length;
            // Notes are not photos: counted on their own
            const notes = data.files.filter(file => file.type === 'note').length;
            const photos = data.files.length - snaps - notes;
            const counts = [];
            if (folders) counts.push(t('admin.countFolders', { count: folders }));
            counts.push(t('admin.countPhotos', { count: photos }));
            if (snaps) counts.push(t('admin.countSnaps', { count: snaps }));
            if (notes) counts.push(t('admin.countNotes', { count: notes }));
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
                    <span class="material-symbols-outlined" aria-hidden="true">folder</span>
                </div>
            </div>
            <div class="folder-meta">
                <div class="folder-text">
                    <div class="folder-name"></div>
                    <div class="folder-count"></div>
                </div>
                <button type="button" class="folder-more" data-edit-only aria-label="${escapeHtml(t('admin.folderOptions'))}" aria-haspopup="menu" aria-expanded="false">
                    <span class="material-symbols-outlined">more_vert</span>
                </button>
            </div>
        `;
        div.querySelector('.folder-name').textContent = folder.name;
        // "2 folders · 12 photos": what is directly inside, when the listing says
        const counts = folder.counts;
        const countLine = div.querySelector('.folder-count');
        if (counts) {
            const parts = [];
            if (counts.folders) parts.push(t('admin.countFolders', { count: counts.folders }));
            if (counts.photos || !counts.folders) parts.push(t('admin.countPhotos', { count: counts.photos }));
            countLine.textContent = parts.join(' · ');
        } else {
            countLine.remove();
        }
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

    // A note in this folder opens in the note editor on the Notes page
    openNote(file) {
        window.location.href = `/notes?folder=${encodeURIComponent(this.currentPath)}&edit=${encodeURIComponent(file.path)}`;
    }

    // Snaps and notes open in their editors; photos in the photo viewer
    openTile(file) {
        if (file.type === 'snap') this.openSnap(file);
        else if (file.type === 'note') this.openNote(file);
        else this.showPhotoModal(file.url, file.name);
    }

    // A photo tile: the photo in its own shape and nothing else, until hovered (a
    // round check to select, one ⋮ menu) or selection starts (every tile shows its
    // check). No file names: they are the uploads' internal names.
    createFileElement(file) {
        const isSnap = file.type === 'snap';
        const isNote = file.type === 'note';
        const type = this.tileType(file);
        const div = document.createElement('div');
        div.className = isSnap ? 'file-item image snap' : isNote ? 'file-item image snap note' : 'file-item image';
        div.dataset.path = file.path;
        div.dataset.type = type;
        const openLabel = isSnap ? t('admin.editSnap') : isNote ? t('notes.editNote') : t('admin.viewPhoto');
        div.innerHTML = `
            <div class="admin-photo-image">
                <img alt="" loading="lazy" decoding="async">
            </div>
            <button type="button" class="tile-open" aria-label="${escapeHtml(openLabel)}"></button>
            <span class="tile-shade" aria-hidden="true"></span>
            <label class="photo-grid-checkbox" data-edit-only>
                <input type="checkbox" class="tile-check-input" aria-label="${escapeHtml(t('admin.selectPhoto'))}">
                <span class="tile-check" aria-hidden="true"></span>
            </label>
            <button type="button" class="btn-icon photo-more" data-edit-only data-action="more" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(t('admin.photoOptions'))}" title="${escapeHtml(t('admin.photoOptions'))}">
                <span class="material-symbols-outlined" aria-hidden="true">more_vert</span>
            </button>
        `;
        const img = div.querySelector('img');
        // The thumbnail in the photo's own shape (older listings: the square one)
        img.src = file.preview || file.thumbnail || file.url;
        // Not measured yet: measured as it loads, and the rows laid out again
        if (type === 'image' && !(file.width > 0 && file.height > 0)) {
            img.addEventListener('load', () => {
                if (!img.naturalWidth || !img.naturalHeight || this.measured.has(file.path)) return;
                this.measured.set(file.path, { width: img.naturalWidth, height: img.naturalHeight });
                this.layoutStale = true;
                this.scheduleLayout();
            });
        }
        if (isSnap) this.dressSnapTile(div, file);
        if (isNote) this.dressNoteTile(div, file);
        
        // The check: starts selection, or ticks and unticks in it
        const checkbox = div.querySelector('input[type="checkbox"]');
        checkbox.dataset.path = file.path;
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            this.toggleSelection(file);
        });
        checkbox.addEventListener('click', (e) => e.stopPropagation());

        // ⋮: the same menu as right-click (View, Rotate, Move to…, Delete)
        div.querySelector('.photo-more').addEventListener('click', (e) => {
            e.stopPropagation();
            this.showContextMenu(e, {...file, type});
        });
        
        // Drag onto a folder to move it; a selected photo brings the whole selection along
        div.draggable = true;
        // A snap without photos has no <img>, only its drawn page
        div.querySelectorAll('img').forEach(img => { img.draggable = false; });
        div.addEventListener('dragstart', (e) => {
            div.classList.remove('selecting');
            if (!this.canEdit()) {
                e.preventDefault(); // nothing to move it with
                return;
            }
            const paths = this.selection.has(file.path) ? this.selection.keys() : [file.path];
            e.dataTransfer.setData(PHOTO_DRAG_TYPE, JSON.stringify(paths));
            this.draggingPaths = paths;
            e.dataTransfer.effectAllowed = 'move';
            document.querySelector('.app').classList.add('photo-dragging');
            paths.forEach(p => document.querySelector(`.file-item[data-path="${CSS.escape(p)}"]`)?.classList.add('dragging'));
        });
        this.makeReorderTarget(div, file);
        div.addEventListener('dragend', () => {
            this.draggingPaths = null;
            this.clearReorderMarks();
            document.querySelector('.app').classList.remove('photo-dragging');
            document.querySelectorAll('.file-item.dragging').forEach(el => el.classList.remove('dragging'));
            document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        });

        // Hold a photo to select it. A tap still opens it, and the click that ends
        // a finished hold is swallowed (js/longPress.js).
        const longPress = SoraLongPress.attach(div, {
            delay: this.longPressDelay,
            ignore: '.photo-grid-checkbox, .photo-more',
            onStart: (e) => {
                // Fingers scroll and hold; only a mouse picks the tile up to drag it
                div.draggable = e.pointerType === 'mouse';
                div.classList.add('selecting');
            },
            onLongPress: () => {
                div.classList.remove('selecting');
                if (!this.canEdit()) return;
                this.toggleSelection(file);
                if (navigator.vibrate) navigator.vibrate(30);
            },
            onEnd: () => div.classList.remove('selecting')
        });
        div.addEventListener('dragstart', () => longPress.cancel());
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, {...file, type}));
        
        // A click opens it; while photos are selected it ticks it instead
        div.addEventListener('click', (e) => {
            if (e.target.closest('.photo-grid-checkbox') || e.target.closest('.photo-more')) return;
            e.preventDefault();
            if (this.selection.active && this.canEdit()) this.toggleSelection(file);
            else this.openTile(file);
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
        badge.innerHTML = '<span class="material-symbols-outlined">auto_stories</span>';
        const label = document.createElement('span');
        label.className = 'snap-badge-text';
        label.textContent = t('admin.snapBadge');
        badge.appendChild(label);
        div.appendChild(badge);

        // Its title says which page it is, to a screen reader
        if (snap.title) div.querySelector('.tile-open').setAttribute('aria-label', `${t('admin.editSnap')}: ${snap.title}`);
    }

    // A note gets the same drawn page as a snap, with a note badge: it is not a
    // photo, and the frame shows it on its schedule rather than in the rotation
    dressNoteTile(div, file) {
        this.dressSnapTile(div, { ...file, snap: file.note });
        div.querySelector('.snap-badge .material-symbols-outlined').textContent = 'sticky_note_2';
        div.querySelector('.snap-badge-text').textContent = t('admin.noteBadge');
        const title = file.note && file.note.title;
        div.querySelector('.tile-open').setAttribute('aria-label', title ? `${t('notes.editNote')}: ${title}` : t('notes.editNote'));
    }

    createGooglePhotosImportElement() {
        const div = document.createElement('div');
        div.className = 'file-item google-photos-import';
        div.dataset.editOnly = '';
        div.dataset.ownerOnly = '';
        div.dataset.type = 'google-photos-import';
        div.innerHTML = `
            <span class="material-icons">add</span>
            <span class="import-text"></span>
        `;
        div.querySelector('.import-text').textContent = t('admin.static_022');
        
        div.addEventListener('click', () => this.openGooglePhotosImport());
        
        return div;
    }

    openGooglePhotosImport() {
        if (window.googlePhotosSync) {
            window.googlePhotosSync.openGooglePhotosModal(this.currentPath);
        } else {
            this.showToast(t('admin.googlePhotosUnavailable'), 'error');
        }
    }

    navigateTo(path) {
        if (path === this.currentPath) return;
        this.currentPath = path;
        // Opened from selection: the folder takes selection's history entry, so
        // Back still goes to the folder before
        const fromSelection = this.selection.ownsEntry;
        this.selection.forget();
        this.updateURL(!fromSelection);
        this.loadFolderContents();
    }

    navigateBack() {
        if (this.currentPath === 'uploads') return;

        const pathParts = this.currentPath.split('/');
        pathParts.pop();
        this.navigateTo(pathParts.join('/') || 'uploads');
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
            span.textContent = index === 0 ? t('admin.breadcrumbHome') : part;
            
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
            this.showToast(t('admin.enterFolderName'), 'error');
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
                this.showToast(t('admin.folderCreated'), 'success');
                this.hideCreateFolderModal();
                this.loadFolderContents();
            } else {
                this.showToast(i18n.error(data, 'admin.createFolderFailed'), 'error');
            }
        } catch (error) {
            console.error('Error creating folder:', error);
            this.showToast(t('admin.createFolderFailed'), 'error');
        }
    }

    showUploadModal() {
        const modal = document.getElementById('uploadModal');
        modal.showModal();
        this.selectedFiles = [];
        this.showUploadError(null);
        this.updateUploadButton();
        this.updateSelectedFilesDisplay();
    }

    hideUploadModal() {
        const modal = document.getElementById('uploadModal');
        modal.close();
        document.getElementById('fileInput').value = '';
        this.selectedFiles = [];
        this.showUploadError(null);
        this.hideUploadProgress();
        this.updateSelectedFilesDisplay();
    }

    // Inside the upload dialog, what happened to the photos (a full library, say),
    // in view and read out; null clears it
    showUploadError(message) {
        const box = document.getElementById('uploadError');
        if (!box) return;
        box.textContent = message || '';
        box.classList.toggle('hidden', !message);
        if (message) {
            box.scrollIntoView?.({ block: 'nearest' });
            box.focus?.({ preventScroll: true });
        }
    }

    updateUploadButton() {
        const btn = document.getElementById('confirmUploadBtn');
        const btnText = document.getElementById('uploadBtnText');
        // Not again while photos are on their way: one upload, one answer
        btn.disabled = this.selectedFiles.length === 0 || Boolean(this.uploading);
        
        if (this.selectedFiles.length > 0) {
            btnText.textContent = t('admin.uploadFilesButton', { count: this.selectedFiles.length });
        } else {
            btnText.textContent = t('admin.static_012');
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

    // Sends the photos one at a time (js/photoUpload.js). Answers like a fetch response:
    // null if the session expired, otherwise { ok, json() } for the whole upload.
    async uploadInBatches(files, targetPath) {
        const list = Array.from(files);
        const result = await PhotoUpload.uploadAll(list, targetPath, { onProgress: progress => this.setUploadProgress(progress) });
        if (result.sessionExpired) {
            this.handleSessionExpired();
            return null;
        }
        if (result.ok) {
            PhotoUpload.offerInstall(t);
            return { ok: true, json: async () => ({ files: result.files }) };
        }
        // Some photos can be saved before one fails (the account filling up mid-way)
        const failed = result.status === 0 ? {} : result.data;
        const message = i18n.error(failed, 'admin.uploadFailed');
        if (result.files.length) this.loadFolderContents(); // show what did get saved
        return { ok: false, json: async () => ({
            ...failed,
            code: undefined, // already translated into message
            message: result.files.length ? t('admin.uploadPartial', { done: result.files.length, total: list.length, message }) : message,
            // For the upload dialog: "Not added: …" when none of them were
            noneSaved: result.files.length === 0,
            reason: message
        }) };
    }

    // The real state of an upload, on whichever progress bar is showing
    setUploadProgress({ done, total, fraction }) {
        const width = `${Math.round(fraction * 100)}%`;
        const text = t('admin.uploadingCount', { done: Math.min(done + 1, total), total });
        document.querySelectorAll('.progress-fill, .empty-state-progress-fill').forEach(bar => { bar.style.width = width; });
        document.querySelectorAll('.progress-text, .empty-state-progress-text').forEach(label => { label.textContent = text; });
    }

    // Photos shared from the phone's gallery arrive here, ready to upload into the open folder
    async takeSharedPhotos() {
        PhotoUpload.registerShareWorker();
        const shared = (await PhotoUpload.takeShared()).filter(isImageFile);
        if (new URLSearchParams(location.search).has('shared')) history.replaceState(null, '', location.pathname + location.hash);
        if (!shared.length) return;
        await window.SoraScope?.ready;
        if (!this.canEdit()) {
            this.showToast(t('errors.VIEW_ONLY'), 'error');
            return;
        }
        this.showUploadModal();
        this.selectedFiles = shared;
        this.updateUploadButton();
        this.updateSelectedFilesDisplay();
    }

    async uploadFiles() {
        if (this.selectedFiles.length === 0 || this.uploading) return;
        
        this.uploading = true;
        this.updateUploadButton();
        this.showUploadError(null);
        this.showUploadProgress();
        
        try {
            const response = await this.uploadInBatches(this.selectedFiles, this.currentPath);
            if (!response) {
                return; // Session expired
            }
            
            const data = await response.json();
            
            if (response.ok) {
                this.showToast(t('admin.filesUploaded', { count: data.files.length }), 'success');
                this.hideUploadModal();
                this.loadFolderContents();
            } else {
                // Once, as a toast in front of the dialog, and kept in the dialog itself
                const message = i18n.error(data, 'admin.uploadFailed');
                this.showToast(message, 'error');
                this.showUploadError(data.noneSaved ? t('admin.uploadNotAdded', { message: data.reason || message }) : message);
            }
        } catch (error) {
            console.error('Error uploading files:', error);
            this.showToast(t('admin.uploadFailed'), 'error');
            this.showUploadError(t('admin.uploadFailed'));
        } finally {
            this.uploading = false;
            this.hideUploadProgress();
            this.updateUploadButton();
        }
    }

    showUploadProgress() {
        document.getElementById('uploadProgress').classList.remove('hidden');
        const progressFill = document.querySelector('.progress-fill');
        progressFill.style.width = '0%';
    }

    hideUploadProgress() {
        document.getElementById('uploadProgress').classList.add('hidden');
    }

    async uploadFilesDirectly(files, targetPath = this.currentPath) {
        if (files.length === 0) return;
        
        const folderName = this.folderDisplayName(targetPath);
        this.showToast(t('admin.uploadingTo', { count: files.length, name: folderName }), 'info');
        
        try {
            const response = await this.uploadInBatches(files, targetPath);
            if (!response) return; // Session expired
            
            const data = await response.json();
            
            if (response.ok) {
                this.showToast(t('admin.photosAddedTo', { count: data.files.length, name: folderName }), 'success');
                this.loadFolderContents();
            } else {
                this.showToast(i18n.error(data, 'admin.uploadFailed'), 'error');
            }
        } catch (error) {
            console.error('Error uploading files:', error);
            this.showToast(t('admin.uploadFailed'), 'error');
        }
    }

    showContextMenu(event, item) {
        event.preventDefault();
        if (!this.canEdit()) return; // every item in it changes something
        this.contextMenuTarget = item;
        const popover = document.getElementById('contextMenuPopover');
        // Focus comes back here when the menu closes: the options button, or what had
        // focus for a right-click (the menu key on a keyboard)
        const opener = event.type === 'click' && event.currentTarget instanceof Element ? event.currentTarget : document.activeElement;
        if (!popover.contains(opener)) {
            this.markMenuOpen(this.contextMenuOpener, false);
            this.contextMenuOpener = opener && opener !== document.body ? opener : null;
        }
        this.markMenuOpen(this.contextMenuOpener, true);
        
        // Show/hide menu items based on item type (data-for lists the types); Move
        // earlier and later only in "My order" (data-order)
        popover.querySelectorAll('[data-for]').forEach(menuItem => {
            const forType = menuItem.dataset.for.split(' ').includes(item.type);
            const forOrder = !menuItem.dataset.order || menuItem.dataset.order === this.playOrder;
            menuItem.style.display = forType && forOrder ? '' : 'none';
        });
        
        // Under the options button, or at the right-click, kept on screen (js/placeMenu.js)
        const anchor = event.type === 'click' && event.currentTarget instanceof Element
            ? event.currentTarget.getBoundingClientRect()
            : null;
        popover.style.position = 'fixed';
        popover.style.maxHeight = '';
        popover.style.overflowY = '';
        
        // Show the popover (re-opening moves it to the new spot), then measure it
        if (!popover.matches(':popover-open')) popover.showPopover();
        const spot = SoraPlaceMenu.place({
            anchor,
            point: { x: event.clientX, y: event.clientY },
            width: popover.offsetWidth,
            height: popover.offsetHeight,
            viewport: { width: window.innerWidth, height: window.innerHeight }
        });
        popover.style.left = spot.left + 'px';
        popover.style.top = spot.top + 'px';
        if (spot.maxHeight !== null) {
            popover.style.maxHeight = spot.maxHeight + 'px';
            popover.style.overflowY = 'auto';
        }
        this.contextMenuItems()[0]?.focus({ preventScroll: true });
    }

    // An options button says whether its menu is open
    markMenuOpen(button, open) {
        if (button?.hasAttribute('aria-haspopup')) button.setAttribute('aria-expanded', String(open));
    }

    // The menu's items shown for this photo or folder
    contextMenuItems() {
        return [...document.getElementById('contextMenuPopover').querySelectorAll('.menu-item')]
            .filter(item => item.style.display !== 'none');
    }

    // Keys inside the open menu: up and down (round the ends), Home and End;
    // Enter and Space press the item (they are buttons); Escape (see setupEventListeners)
    // and Tab close it, back on the button it opened from
    contextMenuKey(e) {
        const items = this.contextMenuItems();
        if (!items.length) return;
        const at = items.indexOf(document.activeElement);
        const to = {
            ArrowDown: (at + 1) % items.length,
            ArrowUp: (at <= 0 ? items.length : at) - 1,
            Home: 0,
            End: items.length - 1
        }[e.key];
        if (to !== undefined) {
            e.preventDefault();
            items[to].focus();
        } else if (e.key === 'Tab') {
            this.hideContextMenu(); // Tab then goes on from the button
        }
    }

    hideContextMenu({ returnFocus = true } = {}) {
        const popover = document.getElementById('contextMenuPopover');
        const hadFocus = popover.contains(document.activeElement);
        if (popover.matches(':popover-open')) {
            popover.hidePopover();
        }
        this.contextMenuTarget = null;
        const opener = this.contextMenuOpener;
        this.contextMenuOpener = null;
        if (!opener) return;
        this.markMenuOpen(opener, false);
        if (returnFocus && hadFocus && opener.isConnected) opener.focus({ preventScroll: true });
    }

    async handleContextMenuAction(action) {
        if (!this.contextMenuTarget) return;
        
        // Store the target before hiding the menu
        const targetItem = this.contextMenuTarget;
        this.hideContextMenu();
        
        switch (action) {
            case 'view':
                this.openTile(targetItem);
                break;
            case 'move':
                this.openMoveDialog([targetItem.path]);
                break;
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
            case 'edit-note':
                this.openNote(targetItem);
                break;
            case 'move-earlier':
            case 'move-later':
                this.nudge(targetItem, action === 'move-earlier' ? -1 : 1);
                break;
        }
    }

    // ---------- Play order -----------------------------------------------

    showPlayOrder() {
        const icons = { shuffle: 'shuffle', newest: 'arrow_downward', oldest: 'arrow_upward', custom: 'drag_indicator' };
        document.getElementById('playOrderSelect').value = this.playOrder;
        document.getElementById('playOrderIcon').textContent = icons[this.playOrder] || 'shuffle';
        document.getElementById('fileGrid').classList.toggle('custom-order', this.playOrder === 'custom');
    }

    async setPlayOrder(order, sequence) {
        const previous = this.playOrder;
        this.playOrder = order;
        this.showPlayOrder();
        try {
            const body = sequence ? { order, sequence } : { order };
            const response = await this.authenticatedFetch(`/api/admin/folders/order?path=${encodeURIComponent(this.currentPath)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!response) return false;
            const data = await response.json();
            if (!response.ok) throw new Error(i18n.error(data, 'admin.playOrderSaveFailed'));

            if (sequence) {
                if (previous !== 'custom') this.showToast(t('admin.playOrderCustom'), 'success');
                return true;
            }
            const messages = {
                shuffle: t('admin.playOrderShuffle'),
                newest: t('admin.playOrderNewest'),
                oldest: t('admin.playOrderOldest'),
                custom: t('admin.playOrderCustom')
            };
            this.showToast(messages[order], 'success');
            this.loadFolderContents(); // the grid follows the play order
            return true;
        } catch (error) {
            this.playOrder = previous;
            this.showPlayOrder();
            this.showToast(error.message, 'error');
            return false;
        }
    }

    // A photo tile takes other photos from this folder dropped before or after it
    makeReorderTarget(div, file) {
        const sideOf = (e) => {
            const rect = div.getBoundingClientRect();
            return e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
        };
        const accepts = (e) => isPhotoDrag(e) && this.draggingPaths && !this.draggingPaths.includes(file.path);

        div.addEventListener('dragover', (e) => {
            if (!accepts(e)) return;
            e.preventDefault();
            e.stopPropagation(); // not an upload or a folder move
            e.dataTransfer.dropEffect = 'move';
            const side = sideOf(e);
            if (!div.classList.contains(`drop-${side}`)) {
                this.clearReorderMarks();
                div.classList.add(`drop-${side}`);
            }
        });
        div.addEventListener('dragleave', (e) => {
            if (!div.contains(e.relatedTarget)) div.classList.remove('drop-before', 'drop-after');
        });
        div.addEventListener('drop', (e) => {
            if (!accepts(e)) return;
            e.preventDefault();
            e.stopPropagation();
            const moving = this.draggingPaths.map(p => p.split('/').pop());
            this.clearReorderMarks();
            this.reorder(moving, file.name, sideOf(e));
        });
    }

    clearReorderMarks() {
        document.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
    }

    // Put the moving files (kept in their current order) before or after a file
    async reorder(moving, targetName, side) {
        const keep = this.fileNames.filter(name => !moving.includes(name));
        const ordered = this.fileNames.filter(name => moving.includes(name));
        const at = keep.indexOf(targetName) + (side === 'after' ? 1 : 0);
        const sequence = [...keep.slice(0, at), ...ordered, ...keep.slice(at)];
        if (sequence.join('/') === this.fileNames.join('/') && this.playOrder === 'custom') return;

        // Rearrange the tiles straight away, then save
        const previous = this.fileNames;
        this.fileNames = sequence;
        this.arrangeTiles();
        if (!await this.setPlayOrder('custom', sequence)) {
            this.fileNames = previous;
            this.arrangeTiles();
        }
    }

    // Menu alternative to dragging (touch screens): swap with the neighbour
    nudge(item, step) {
        const index = this.fileNames.indexOf(item.name);
        const neighbour = this.fileNames[index + step];
        if (index < 0 || !neighbour) {
            this.showToast(step < 0 ? t('admin.alreadyFirst') : t('admin.alreadyLast'), 'info');
            return;
        }
        this.reorder([item.name], neighbour, step < 0 ? 'before' : 'after');
    }

    arrangeTiles() {
        // The rows follow the new order
        const rank = new Map(this.fileNames.map((name, i) => [name, i]));
        this.photoFiles = (this.photoFiles || []).slice().sort((a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity));
        this.layoutPhotos();
        this.availableImages = this.availableImages
            .slice()
            .sort((a, b) => this.fileNames.indexOf(a.name) - this.fileNames.indexOf(b.name))
            .map((file, index) => ({ ...file, index }));
        this.updatePhotoModalNav();
    }

    // "New note": the note editor, writing into the folder that is open, and back
    // here when it's saved or closed (js/notes.js)
    createNote() {
        window.location.href = `/notes?${new URLSearchParams({ folder: this.currentPath, new: '1' })}`;
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
            this.showToast(t('admin.deleteInvalid'), 'error');
            return;
        }
        
        // Show proper confirmation dialog
        const confirmDelete = await this.showDeleteConfirmation(item.name, item.type || 'image');
        if (!confirmDelete) return;
        
        try {
            const endpoint = { folder: '/api/admin/folders', note: '/api/notes' }[item.type] || '/api/images';
            console.log('Delete endpoint:', endpoint, 'Path:', item.path);
            const response = await this.authenticatedFetch(`${endpoint}?path=${encodeURIComponent(item.path)}`, {
                method: 'DELETE'
            });
            if (!response) return; // Session expired
            
            const data = await response.json();
            console.log('Delete response:', data);
            
            if (response.ok) {
                this.showToast({ folder: t('admin.folderDeleted'), snap: t('admin.snapDeleted'), note: t('notes.noteDeleted') }[item.type] || t('admin.imageDeleted'), 'success');
                this.loadFolderContents();
            } else {
                this.showToast(i18n.error(data, 'admin.deleteFailed'), 'error');
            }
        } catch (error) {
            console.error('Error deleting item:', error);
            this.showToast(t('admin.deleteFailed'), 'error');
        }
    }

    async rotateImage(item, angle = 90) {
        console.log('Attempting to rotate image:', item, 'by', angle, 'degrees');
        
        if (!item || !item.path || item.type !== 'image') {
            console.error('Invalid item for rotation:', item);
            this.showToast(t('admin.rotateInvalid'), 'error');
            return;
        }
        
        try {
            const right = angle > 0;
            this.showToast(right ? t('admin.rotatingRight') : t('admin.rotatingLeft'), 'info');
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
                this.showToast(right ? t('admin.rotatedRight') : t('admin.rotatedLeft'), 'success');
                // Force UI refresh with cache busting
                await this.refreshImageInGrid(item);
            } else {
                this.showToast(i18n.error(data, 'admin.rotationFailed'), 'error');
            }
        } catch (error) {
            console.error('Error rotating image:', error);
            this.showToast(t('admin.rotationFailed'), 'error');
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

    showToast(message, type = 'info') {
        showToast(message, type);
    }

    showPhotoModal(imageUrl, imageName) {
        const modal = document.getElementById('photoModal');
        const modalImage = document.getElementById('modalImage');
        
        this.currentImageUrl = imageUrl;
        this.currentImageSlot = this.currentImagePosition();
        
        modalImage.src = imageUrl;
        modalImage.alt = imageName;
        document.getElementById('modalPhotoName').textContent = imageName;
        this.updatePhotoModalNav();
        
        // Reset zoom state
        modalImage.classList.remove('zoomed');
        modalImage.style.transform = '';
        this.isZoomed = false;
        this.dragState = { isDragging: false, startX: 0, startY: 0, translateX: 0, translateY: 0 };
        
        // Add event listeners for zoom and pan
        this.setupPhotoModalInteractions(modalImage);
        
        if (!modal.open) {
            modal.showModal();
            // An entry for the viewer: the phone's Back button closes it
            if (!history.state?.photo) history.pushState({ ...history.state, photo: true }, '', location.href);
        }
    }

    hidePhotoModal() {
        const modal = document.getElementById('photoModal');
        modal.close();
        this.currentImageUrl = null;
        
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

    // ---------- Selection ------------------------------------------------

    toggleSelection(file) {
        if (!this.canEdit()) return; // selecting is for deleting and moving
        this.selection.toggle(file.path);
    }

    // Every photo, snap and note in this folder
    selectAll() {
        if (!this.canEdit()) return;
        this.selection.selectAll((this.photoFiles || []).map(file => file.path));
    }

    clearSelection() {
        this.selection.clear();
    }

    // The tiles' checks, the grid's selecting look and the selection bar
    updateSelectionUI() {
        const selection = this.selection;
        const count = selection.size;
        (this.tiles || new Map()).forEach((tile, path) => {
            const on = selection.has(path);
            tile.classList.toggle('selected', on);
            const checkbox = tile.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.checked = on;
        });
        document.getElementById('fileGrid')?.classList.toggle('selecting', count > 0);
        document.documentElement?.classList.toggle('is-selecting', count > 0);

        const bar = document.getElementById('selectionFab');
        if (!bar) return;
        bar.classList.toggle('hidden', count === 0);
        document.getElementById('fabBadge').textContent = t('admin.selectedCount', { count });
        const all = (this.photoFiles || []).length;
        document.getElementById('selectAllBtn').hidden = count >= all;
        // One photo: its own menu (Rotate, Create snap…) is a tap away on phones too
        document.getElementById('selectionMoreBtn').hidden = count !== 1;
    }

    // ---------- Move to… ------------------------------------------------
    // A small folder picker: it opens on this folder, goes into a folder with a
    // click and up with the back arrow, and "Move here" moves the photos there.

    openMoveDialog(paths) {
        if (!this.canEdit() || !paths || !paths.length) return;
        this.moving = { paths: [...paths], from: this.currentPath, at: this.currentPath };
        const dialog = document.getElementById('moveDialog');
        document.getElementById('moveTitle').textContent = t('admin.moveTitle', { count: paths.length });
        if (!dialog.open) dialog.showModal();
        // Opens on this folder, or beside it when it has no folders inside
        this.showMoveFolder(this.currentPath, { orParent: true });
    }

    moveParent() {
        const parts = (this.moving?.at || 'uploads').split('/');
        parts.pop();
        return parts.join('/') || 'uploads';
    }

    async showMoveFolder(path, { orParent = false } = {}) {
        if (!this.moving) return;
        this.moving.at = path;
        const request = this.moveRequest = (this.moveRequest || 0) + 1;
        const list = document.getElementById('moveList');
        const here = document.getElementById('moveHereBtn');
        document.getElementById('moveWhere').textContent = this.folderDisplayName(path);
        document.getElementById('moveUpBtn').hidden = path === 'uploads';
        here.disabled = true;
        list.setAttribute('aria-busy', 'true');
        try {
            const response = await this.authenticatedFetch(`/api/admin/folders?path=${encodeURIComponent(path)}`);
            if (!response || request !== this.moveRequest) return;
            const data = await response.json();
            if (!response.ok) throw new Error(i18n.error(data, 'admin.loadFolderFailed'));
            if (orParent && !data.folders.length && path !== 'uploads') return this.showMoveFolder(this.moveParent());
            list.replaceChildren(...data.folders.map(folder => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'move-folder';
                row.dataset.path = folder.path;
                row.innerHTML = `
                    <span class="move-folder-cover"><span class="material-symbols-outlined" aria-hidden="true">folder</span></span>
                    <span class="move-folder-name"></span>
                    <span class="material-symbols-outlined move-folder-go" aria-hidden="true">chevron_right</span>`;
                row.querySelector('.move-folder-name').textContent = folder.name;
                if (folder.thumbnail) {
                    const img = document.createElement('img');
                    img.alt = '';
                    img.loading = 'lazy';
                    img.src = folder.thumbnail;
                    img.addEventListener('error', () => img.remove());
                    row.querySelector('.move-folder-cover').appendChild(img);
                }
                return row;
            }));
            if (!data.folders.length) {
                const empty = document.createElement('p');
                empty.className = 'move-empty';
                empty.textContent = t('admin.moveNoFolders');
                list.appendChild(empty);
            }
            // Not where they already are, nor a folder this person can't change
            here.disabled = path === this.moving.from || data.canChange === false;
        } catch (error) {
            if (request !== this.moveRequest) return;
            list.replaceChildren();
            this.showToast(error.message || t('admin.loadFolderFailed'), 'error');
        } finally {
            if (request === this.moveRequest) list.removeAttribute('aria-busy');
        }
    }

    async confirmMove() {
        if (!this.moving || document.getElementById('moveHereBtn').disabled) return;
        const { paths, at } = this.moving;
        this.moving = null;
        document.getElementById('moveDialog').close();
        this.clearSelection();
        await this.movePhotos(paths, at);
    }

    showBulkDeleteModal() {
        if (this.selection.size === 0) return;
        
        const modal = document.getElementById('bulkDeleteModal');
        document.getElementById('bulk-delete-description').textContent = t('admin.bulkDeleteConfirm', { count: this.selection.size });
        modal.showModal();
    }

    hideBulkDeleteModal() {
        const modal = document.getElementById('bulkDeleteModal');
        modal.close();
    }

    async confirmBulkDelete() {
        const selectedPaths = this.selection.keys();
        
        if (selectedPaths.length === 0) {
            this.hideBulkDeleteModal();
            return;
        }
        
        try {
            this.showToast(t('admin.deletingPhotos'), 'info');
            
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
                this.showToast(t('admin.photosDeleted', { count: data.deletedCount }), 'success');
                this.clearSelection();
                this.loadFolderContents(); // Refresh the grid
            } else {
                console.error('Bulk delete failed:', data);
                this.showToast(i18n.error(data, 'admin.deletePhotosFailed'), 'error');
            }
        } catch (error) {
            console.error('Error during bulk delete:', error);
            this.showToast(t('admin.deletePhotosFailed'), 'error');
        } finally {
            this.hideBulkDeleteModal();
        }
    }

    // Enhanced confirmation dialog for single item deletion
    async showDeleteConfirmation(itemName, itemType = 'image') {
        const deleteLabel = escapeHtml({ folder: t('admin.deleteFolder'), snap: t('admin.deleteSnap'), note: t('notes.static_017') }[itemType] || t('admin.deletePhoto'));
        return new Promise((resolve) => {
            // Create a custom confirmation dialog
            const dialogHtml = `
                <dialog id="deleteConfirmModal" class="dialog" aria-labelledby="delete-confirm-title">
                    <article>
                        <header>
                            <h2 id="delete-confirm-title">${deleteLabel}</h2>
                        </header>
                        <section>
                            <p>${t('admin.deleteConfirm', { name: escapeHtml(itemName) })}</p>
                            <p class="text-sm text-destructive mt-2">${escapeHtml(t('admin.cannotUndo'))}</p>
                        </section>
                        <footer>
                            <button id="cancelSingleDeleteBtn" class="btn-outline">${escapeHtml(t('common.cancel'))}</button>
                            <button id="confirmSingleDeleteBtn" class="btn-destructive">
                                <span class="material-symbols-outlined">delete</span>
                                ${deleteLabel}
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
            
            const files = Array.from(e.dataTransfer.files).filter(isImageFile);
            this.handleEmptyStateFileSelection(files);
        });
    }

    handleEmptyStateFileSelection(files) {
        this.emptyStateSelectedFiles = files.filter(isImageFile);
        this.updateEmptyStateUploadButton();
        this.updateEmptyStateFilesDisplay();
    }

    updateEmptyStateUploadButton() {
        const btn = document.getElementById('emptyStateUploadBtn');
        const btnText = document.getElementById('emptyStateUploadBtnText');
        const cancelBtn = document.getElementById('emptyStateCancelBtn');
        
        btn.disabled = !this.emptyStateSelectedFiles || this.emptyStateSelectedFiles.length === 0 || Boolean(this.uploading);
        
        if (this.emptyStateSelectedFiles && this.emptyStateSelectedFiles.length > 0) {
            btnText.textContent = t('admin.uploadFilesButton', { count: this.emptyStateSelectedFiles.length });
            cancelBtn.classList.remove('hidden');
        } else {
            btnText.textContent = t('admin.static_012');
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
        if (!this.emptyStateSelectedFiles || this.emptyStateSelectedFiles.length === 0 || this.uploading) return;
        
        this.uploading = true;
        this.updateEmptyStateUploadButton();
        this.showEmptyStateUploadProgress();
        
        try {
            const response = await this.uploadInBatches(this.emptyStateSelectedFiles, this.currentPath);
            if (!response) {
                this.hideEmptyStateUploadProgress();
                return; // Session expired
            }
            
            const data = await response.json();
            
            if (response.ok) {
                this.showToast(t('admin.filesUploaded', { count: data.files.length }), 'success');
                this.resetEmptyStateUpload();
                this.loadFolderContents(); // This will hide the empty state and show the uploaded files
            } else {
                this.showToast(i18n.error(data, 'admin.uploadFailed'), 'error');
            }
        } catch (error) {
            console.error('Error uploading files:', error);
            this.showToast(t('admin.uploadFailed'), 'error');
        } finally {
            this.uploading = false;
            this.updateEmptyStateUploadButton();
        }
        
        this.hideEmptyStateUploadProgress();
    }

    showEmptyStateUploadProgress() {
        document.getElementById('emptyStateUploadProgress').classList.remove('hidden');
        const progressFill = document.querySelector('.empty-state-progress-fill');
        progressFill.style.width = '0%';
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

    // Photo modal navigation methods. The position is looked up from the open
    // photo each time, so a folder refresh while the viewer is open (new
    // uploads, reordering) doesn't break Previous / Next.
    currentImagePosition() {
        return this.availableImages.findIndex(img => img.url === this.currentImageUrl);
    }

    // Previous / next only make sense with two or more photos; without them the
    // photo gets the room the buttons would take
    updatePhotoModalNav() {
        const modal = document.getElementById('photoModal');
        const count = this.availableImages.length;
        const many = count > 1;
        document.querySelector('.photo-modal-nav').hidden = !many;
        modal.classList.toggle('has-nav', many);

        // Remember where the open photo sits in the newest list. If it went
        // away in a refresh (deleted, moved), show the photo now in that
        // place, or close the viewer if none are left.
        const position = this.currentImagePosition();
        if (position !== -1) {
            this.currentImageSlot = position;
        } else if (modal.open && this.currentImageUrl) {
            if (count === 0) this.hidePhotoModal();
            else this.navigateToImageAtIndex(Math.min(Math.max(this.currentImageSlot, 0), count - 1));
        }
    }

    navigateToNextImage() {
        const count = this.availableImages.length;
        if (count === 0 || !this.currentImageUrl) return;
        const position = this.currentImagePosition();
        this.navigateToImageAtIndex(position === -1 ? 0 : (position + 1) % count);
    }

    navigateToPreviousImage() {
        const count = this.availableImages.length;
        if (count === 0 || !this.currentImageUrl) return;
        const position = this.currentImagePosition();
        this.navigateToImageAtIndex(position <= 0 ? count - 1 : position - 1);
    }

    navigateToImageAtIndex(index) {
        if (index < 0 || index >= this.availableImages.length) return;
        
        const image = this.availableImages[index];
        const modalImage = document.getElementById('modalImage');
        
        this.currentImageUrl = image.url;
        this.currentImageSlot = index;
        modalImage.src = image.url;
        modalImage.alt = image.name;
        document.getElementById('modalPhotoName').textContent = image.name;
        
        // Reset zoom state when navigating
        modalImage.classList.remove('zoomed');
        modalImage.style.transform = '';
        modalImage.style.cursor = 'zoom-in';
        this.isZoomed = false;
        this.dragState = { isDragging: false, startX: 0, startY: 0, translateX: 0, translateY: 0 };
    }

}

// Back or Forward can bring this page back from the browser's memory just as it
// was left (the back/forward cache), with another library's folders and controls
// if the person switched libraries meanwhile. Load it afresh instead.
function reloadIfRestored(event) {
    if (event && event.persisted) location.reload();
}

// Initialize the admin panel when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.photoFrameAdmin = new PhotoFrameAdmin();
    window.addEventListener('pageshow', reloadIfRestored);
});

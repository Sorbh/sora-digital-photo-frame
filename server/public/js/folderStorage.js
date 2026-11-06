/**
 * Folder Storage - Handles localStorage for folder selection persistence
 */
class FolderStorage {
    constructor() {
        this.STORAGE_KEY = 'photoframe_selected_folder';
        this.HISTORY_KEY = 'photoframe_folder_history';
        this.MAX_HISTORY = 5;
    }

    /**
     * Save selected folder to localStorage
     * @param {string} folderPath - Folder path to save
     * @param {string} folderName - Display name of folder
     */
    saveSelectedFolder(folderPath, folderName = '') {
        try {
            const folderData = {
                path: folderPath,
                name: folderName || folderPath || 'All Folders',
                timestamp: Date.now()
            };
            
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(folderData));
            this.addToHistory(folderData);
            
            console.log('Saved selected folder:', folderData);
        } catch (error) {
            console.error('Error saving selected folder:', error);
        }
    }

    /**
     * Load selected folder from localStorage
     * @returns {Object|null} Folder data or null if not found
     */
    loadSelectedFolder() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (!stored) return null;
            
            const folderData = JSON.parse(stored);
            console.log('Loaded selected folder:', folderData);
            return folderData;
        } catch (error) {
            console.error('Error loading selected folder:', error);
            return null;
        }
    }

    /**
     * Clear selected folder from localStorage
     */
    clearSelectedFolder() {
        try {
            localStorage.removeItem(this.STORAGE_KEY);
            console.log('Cleared selected folder');
        } catch (error) {
            console.error('Error clearing selected folder:', error);
        }
    }

    /**
     * Get currently selected folder path
     * @returns {string} Current folder path or empty string for all folders
     */
    getCurrentFolderPath() {
        const folder = this.loadSelectedFolder();
        return folder ? folder.path : '';
    }

    /**
     * Get currently selected folder name for display
     * @returns {string} Current folder name
     */
    getCurrentFolderName() {
        const folder = this.loadSelectedFolder();
        return folder && folder.path ? folder.name : t('folders.allFoldersTitle');
    }

    /**
     * Add folder to selection history
     * @param {Object} folderData - Folder data to add to history
     */
    addToHistory(folderData) {
        try {
            let history = this.getHistory();
            
            // Remove existing entry for this folder
            history = history.filter(item => item.path !== folderData.path);
            
            // Add to beginning of history
            history.unshift(folderData);
            
            // Limit history size
            if (history.length > this.MAX_HISTORY) {
                history = history.slice(0, this.MAX_HISTORY);
            }
            
            localStorage.setItem(this.HISTORY_KEY, JSON.stringify(history));
        } catch (error) {
            console.error('Error updating folder history:', error);
        }
    }

    /**
     * Get folder selection history
     * @returns {Array} Array of recently selected folders
     */
    getHistory() {
        try {
            const stored = localStorage.getItem(this.HISTORY_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.error('Error loading folder history:', error);
            return [];
        }
    }

    /**
     * Clear folder selection history
     */
    clearHistory() {
        try {
            localStorage.removeItem(this.HISTORY_KEY);
            console.log('Cleared folder history');
        } catch (error) {
            console.error('Error clearing folder history:', error);
        }
    }

    /**
     * Check if a specific folder is currently selected
     * @param {string} folderPath - Folder path to check
     * @returns {boolean} True if folder is currently selected
     */
    isCurrentFolder(folderPath) {
        const current = this.getCurrentFolderPath();
        return current === folderPath;
    }
}

// Export for use in other scripts
window.FolderStorage = FolderStorage;
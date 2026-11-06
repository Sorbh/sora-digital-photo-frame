/**
 * Folder Service - Handles API communication for folder operations
 */
class FolderService {
    constructor() {
        this.baseUrl = '/api';
    }

    /**
     * Get folder structure from API
     * @param {string} folderPath - Optional folder path to get specific folder
     * @returns {Promise<Object>} Folder structure data
     */
    async getFolderStructure(folderPath = '') {
        try {
            const url = folderPath 
                ? `${this.baseUrl}/folders/${encodeURIComponent(folderPath)}`
                : `${this.baseUrl}/folders`;
            
            const response = await fetch(url, {
                credentials: 'include' // Ensure cookies are sent
            });
            
            if (!response.ok) {
                throw new Error(t('folders.httpError', { status: response.status }));
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error(i18n.error(data, 'folders.fetchStructureFailed'));
            }
            
            return data;
        } catch (error) {
            console.error('Error fetching folder structure:', error);
            throw new Error(t('folders.loadFailedDetail', { detail: error.message }));
        }
    }

    /**
     * Get random image with optional folder filter
     * @param {string} folderPath - Optional folder path to filter images
     * @returns {Promise<Object>} Random image data
     */
    async getRandomImage(folderPath = '') {
        try {
            const url = folderPath 
                ? `${this.baseUrl}/images/random?folder=${encodeURIComponent(folderPath)}`
                : `${this.baseUrl}/images/random`;
            
            const response = await fetch(url, {
                credentials: 'include' // Ensure cookies are sent
            });
            
            if (!response.ok) {
                throw new Error(t('folders.httpError', { status: response.status }));
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error(i18n.error(data, 'folders.fetchRandomFailed'));
            }
            
            return data;
        } catch (error) {
            console.error('Error fetching random image:', error);
            throw error;
        }
    }

    /**
     * Get folder thumbnail URL
     * @param {string} folderPath - Folder path
     * @returns {string} Thumbnail URL
     */
    getFolderThumbnailUrl(folderPath) {
        return `${this.baseUrl}/folders/${encodeURIComponent(folderPath)}/thumbnail`;
    }

    /**
     * Get image thumbnail URL
     * @param {string} imageId - Image ID/path
     * @returns {string} Thumbnail URL
     */
    getImageThumbnailUrl(imageId) {
        return `${this.baseUrl}/images/${encodeURIComponent(imageId)}/thumbnail`;
    }
}

// Export for use in other scripts
window.FolderService = FolderService;
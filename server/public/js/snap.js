/**
 * Snap editor: a memory-book page saved as a file in a library folder.
 *
 *   /snap?folder=uploads/Goa                       new snap in that folder
 *   /snap?folder=uploads/Goa&photo=uploads/Goa/a.jpg  new snap starting with a photo
 *   /snap?path=uploads/Goa/our-week.snap.json      edit a snap
 *
 * Saving goes back to the folder in the library.
 */
class SnapEditor extends PageEditor {
    constructor() {
        super(document.getElementById('noteForm'), 'snap');
        const params = new URLSearchParams(window.location.search);
        this.path = params.get('path');
        this.folder = this.path ? this.parentOf(this.path) : (params.get('folder') || 'uploads');
        this.startPhoto = params.get('photo');
        this.init();
    }

    async init() {
        this.renderLayoutPicker();
        this.bindEditorEvents();
        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.save();
        });

        this.pickerPath = this.folder;
        const back = `/admin?path=${encodeURIComponent(this.folder)}`;
        document.getElementById('backLink').href = back;
        document.getElementById('cancelSnapBtn').href = back;
        const parts = this.folder.split('/').filter(Boolean);
        document.getElementById('snapFolder').textContent = parts.length > 1 ? parts.slice(1).join(' / ') : 'Library';

        if (this.path) {
            await this.load();
        } else if (this.startPhoto) {
            this.photos = [this.photoFor(this.startPhoto)];
        }

        this.renderPhotoTiles();
        this.updatePreview();
        this.form.elements.title.focus();
    }

    parentOf(adminPath) {
        return adminPath.split('/').slice(0, -1).join('/') || 'uploads';
    }

    // The same { path, url, thumbnail } the server sends, from a library path
    photoFor(adminPath) {
        const rel = adminPath.replace(/^uploads\//, '');
        return {
            path: rel,
            url: `/uploads/${rel.split('/').map(encodeURIComponent).join('/')}`,
            thumbnail: `/api/images/${encodeURIComponent(rel)}/thumbnail`
        };
    }

    async load() {
        try {
            const { ok, data } = await this.api(`/api/snaps?path=${encodeURIComponent(this.path)}`);
            if (!ok) throw new Error(data.error || 'Could not open the snap');
            document.getElementById('snapHeading').innerHTML = 'Edit <em>snap</em>';
            document.title = `${data.snap.title} · Sora Frame`;
            this.fillPage(data.snap);
        } catch (error) {
            if (error.message === 'Signed out') return;
            this.showToast(error.message, 'error');
            this.path = null;
        }
    }

    async save() {
        this.clearErrors();
        const payload = this.readForm();
        if (!payload.title.trim()) {
            this.showErrors({ title: 'Give the snap a headline' });
            return;
        }

        const btn = document.getElementById('saveSnapBtn');
        btn.disabled = true;
        try {
            const { ok, data } = this.path
                ? await this.api(`/api/snaps?path=${encodeURIComponent(this.path)}`, { method: 'PUT', body: JSON.stringify(payload) })
                : await this.api('/api/snaps', { method: 'POST', body: JSON.stringify({ ...payload, folder: this.folder }) });
            if (!ok) {
                if (data.errors) this.showErrors(data.errors);
                throw new Error(data.error || 'Could not save the snap');
            }
            window.location.href = `/admin?path=${encodeURIComponent(this.folder)}`;
        } catch (error) {
            btn.disabled = false;
            if (error.message !== 'Signed out') this.showToast(error.message, 'error');
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.snapEditor = new SnapEditor();
});

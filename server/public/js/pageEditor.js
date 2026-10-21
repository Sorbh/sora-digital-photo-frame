/**
 * The memory-book page editor shared by Notes and Snaps: headline, message,
 * photos (with a library picker), layout and theme, plus a live preview drawn
 * by the same NotePage renderer the frame uses.
 *
 * Pages using it need the editor markup from notes.html (noteForm,
 * notePreview, layoutPicker, photoTiles, photoPicker, toastContainer).
 */
class PageEditor {
    constructor(form, noun = 'page') {
        this.form = form;
        this.noun = noun;
        this.photos = [];         // [{ path, url, thumbnail }] in the editor
        this.picked = [];         // selection inside the photo picker
        this.pickerPath = 'uploads';
        this.layout = 'auto';
    }

    bindEditorEvents() {
        this.form.addEventListener('input', () => this.updatePreview());
        this.form.addEventListener('change', () => this.updatePreview());

        document.querySelectorAll('.preview-orient button').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.preview-orient button').forEach(b => b.classList.toggle('active', b === btn));
                document.getElementById('notePreview').classList.toggle('is-portrait', btn.dataset.orient === 'portrait');
            });
        });

        document.getElementById('pickerCancel').addEventListener('click', () => document.getElementById('photoPicker').close());
        document.getElementById('pickerDone').addEventListener('click', () => {
            this.photos = this.picked.slice(0, 4);
            document.getElementById('photoPicker').close();
            this.renderPhotoTiles();
            this.updatePreview();
        });
    }

    // The page fields every editor shares
    readPage() {
        const f = this.form.elements;
        return {
            title: f.title.value,
            message: f.message.value,
            signoff: f.signoff.value,
            eyebrow: f.eyebrow.value,
            theme: this.form.querySelector('input[name="theme"]:checked')?.value || 'paper',
            photos: this.photos.map(p => p.path),
            layout: this.layout
        };
    }

    fillPage(page = {}) {
        const f = this.form.elements;
        f.title.value = page.title || '';
        f.message.value = page.message || '';
        f.signoff.value = page.signoff || '';
        f.eyebrow.value = page.eyebrow || '';
        this.form.querySelector(`input[name="theme"][value="${page.theme || 'paper'}"]`).checked = true;
        this.photos = (page.photoUrls || []).map(p => ({ ...p }));
        this.layout = page.layout || 'auto';
    }

    readForm() {
        return this.readPage();
    }

    updatePreview() {
        const data = this.readForm();
        const f = this.form.elements;

        ['title', 'message'].forEach(name => {
            const el = this.form.querySelector(`[data-count-for="${name}"]`);
            const left = Number(f[name].maxLength) - f[name].value.length;
            el.textContent = f[name].value.length ? String(left) : '';
            el.classList.toggle('is-low', left <= 10);
        });

        const previewPage = { ...data, photos: this.photos.map(p => p.thumbnail || p.url) };
        document.getElementById('notePreview').replaceChildren(NotePage.render(previewPage, { fill: true }));
        this.updateLayoutPicker(previewPage);
    }

    // ---------- Data ------------------------------------------------

    async api(url, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: options.body ? { 'Content-Type': 'application/json' } : undefined
        });
        if (response.status === 401) {
            window.location.href = '/login';
            throw new Error('Signed out');
        }
        const data = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, data };
    }

    // ---------- Layouts ---------------------------------------------

    renderLayoutPicker() {
        const picker = document.getElementById('layoutPicker');
        Object.entries(NotePage.templates).forEach(([key, template]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'nf-layout';
            btn.dataset.layout = key;
            btn.setAttribute('role', 'radio');
            const stage = document.createElement('span');
            stage.className = 'note-stage nf-layout-stage';
            const label = document.createElement('span');
            label.className = 'nf-layout-label';
            label.textContent = template.label;
            btn.append(stage, label);
            btn.addEventListener('click', () => {
                this.layout = key;
                this.form.querySelector('[data-error-for="layout"]').textContent = '';
                this.updatePreview();
            });
            picker.appendChild(btn);
        });
    }

    updateLayoutPicker(previewNote) {
        document.querySelectorAll('.nf-layout').forEach(btn => {
            const key = btn.dataset.layout;
            const template = NotePage.templates[key];
            const on = key === this.layout;
            btn.classList.toggle('is-on', on);
            btn.setAttribute('aria-checked', String(on));
            btn.classList.toggle('needs-photos', template.photos > this.photos.length);
            btn.title = template.photos
                ? `${template.label} · ${template.photos} photo${template.photos === 1 ? '' : 's'}`
                : 'Auto · fits any number of photos';
            btn.firstChild.replaceChildren(NotePage.render({ ...previewNote, layout: key }, { fill: true }));
        });

        const needed = NotePage.templates[this.layout]?.photos || 0;
        const missing = needed - this.photos.length;
        const hint = document.getElementById('layoutHint');
        hint.textContent = missing > 0 ? `add ${missing} more photo${missing === 1 ? '' : 's'}` : '';
        hint.classList.toggle('is-warn', missing > 0);
    }

    showErrors(errors) {
        let first = null;
        Object.entries(errors).forEach(([field, message]) => {
            const slot = this.form.querySelector(`[data-error-for="${field}"]`);
            if (slot) slot.textContent = message;
            const input = this.form.elements[field];
            if (input && input.classList) {
                input.classList.add('error');
                first = first || input;
            }
        });
        first?.focus();
    }

    clearErrors() {
        this.form.querySelectorAll('.nf-error').forEach(el => { el.textContent = ''; });
        this.form.querySelectorAll('.error').forEach(el => el.classList.remove('error'));
    }

    // ---------- Photos ----------------------------------------------

    renderPhotoTiles() {
        const wrap = document.getElementById('photoTiles');
        wrap.replaceChildren();

        this.photos.forEach((photo, i) => {
            const tile = document.createElement('div');
            tile.className = 'nf-photo';
            const img = document.createElement('img');
            img.src = photo.thumbnail || photo.url;
            img.alt = '';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'nf-photo-remove';
            remove.title = 'Remove photo';
            remove.setAttribute('aria-label', 'Remove photo');
            remove.innerHTML = '<span class="material-symbols-outlined">close</span>';
            remove.addEventListener('click', () => {
                this.photos.splice(i, 1);
                this.renderPhotoTiles();
                this.updatePreview();
            });
            tile.append(img, remove);
            wrap.appendChild(tile);
        });

        if (this.photos.length < 4) {
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'nf-photo nf-photo-add';
            add.innerHTML = '<span class="material-symbols-outlined">add_photo_alternate</span><span></span>';
            add.lastChild.textContent = this.photos.length ? 'Change' : 'Add photos';
            add.addEventListener('click', () => this.openPicker());
            wrap.appendChild(add);
        }
    }

    openPicker() {
        this.picked = this.photos.map(p => ({ ...p }));
        document.getElementById('photoPicker').showModal();
        this.browse(this.pickerPath);
    }

    async browse(folderPath) {
        const grid = document.getElementById('pickerGrid');
        grid.replaceChildren(this.pickerMessage('hourglass_empty', 'Loading'));
        try {
            const { ok, data } = await this.api(`/api/admin/folders?path=${encodeURIComponent(folderPath)}`);
            if (!ok) throw new Error(data.error || 'Could not open the folder');
            this.pickerPath = folderPath;
            this.renderCrumbs(folderPath);
            this.renderPicker(data.folders || [], (data.files || []).filter(f => /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i.test(f.name)));
        } catch (error) {
            if (error.message === 'Signed out') return;
            if (folderPath !== 'uploads') return this.browse('uploads');
            grid.replaceChildren(this.pickerMessage('error', error.message));
        }
        this.updatePickerCount();
    }

    renderCrumbs(folderPath) {
        const nav = document.getElementById('pickerCrumbs');
        nav.replaceChildren();
        const parts = folderPath.split('/').filter(Boolean);
        parts.forEach((part, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = i === 0 ? 'Library' : part;
            btn.disabled = i === parts.length - 1;
            btn.addEventListener('click', () => this.browse(parts.slice(0, i + 1).join('/')));
            nav.appendChild(btn);
            if (i < parts.length - 1) {
                const sep = document.createElement('span');
                sep.className = 'material-symbols-outlined';
                sep.textContent = 'chevron_right';
                nav.appendChild(sep);
            }
        });
    }

    renderPicker(folders, files) {
        const grid = document.getElementById('pickerGrid');
        grid.replaceChildren();
        if (!folders.length && !files.length) {
            grid.appendChild(this.pickerMessage('photo_library', 'This folder is empty'));
            return;
        }

        folders.forEach(folder => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'picker-item picker-folder';
            const cover = document.createElement('span');
            cover.className = 'picker-cover';
            if (folder.thumbnail) {
                const img = document.createElement('img');
                img.src = folder.thumbnail;
                img.alt = '';
                img.loading = 'lazy';
                cover.appendChild(img);
            } else {
                cover.innerHTML = '<span class="material-symbols-outlined">folder</span>';
            }
            const name = document.createElement('span');
            name.className = 'picker-name';
            name.textContent = folder.name;
            btn.append(cover, name);
            btn.addEventListener('click', () => this.browse(folder.path));
            grid.appendChild(btn);
        });

        files.forEach(file => {
            const photo = {
                path: file.path.replace(/^uploads\//, ''),
                url: file.url,
                thumbnail: file.thumbnail
            };
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'picker-item picker-photo';
            btn.title = file.name;
            const img = document.createElement('img');
            img.src = file.thumbnail || file.url;
            img.alt = file.name;
            img.loading = 'lazy';
            const badge = document.createElement('span');
            badge.className = 'picker-badge';
            btn.append(img, badge);

            const sync = () => {
                const at = this.picked.findIndex(p => p.path === photo.path);
                btn.classList.toggle('is-picked', at !== -1);
                btn.setAttribute('aria-pressed', String(at !== -1));
                badge.textContent = at !== -1 ? String(at + 1) : '';
            };
            btn.addEventListener('click', () => {
                const at = this.picked.findIndex(p => p.path === photo.path);
                if (at !== -1) {
                    this.picked.splice(at, 1);
                } else if (this.picked.length >= 4) {
                    this.showToast(`A ${this.noun} holds up to 4 photos`, 'info');
                    return;
                } else {
                    this.picked.push(photo);
                }
                grid.querySelectorAll('.picker-photo').forEach(el => el._sync?.());
                this.updatePickerCount();
            });
            btn._sync = sync;
            sync();
            grid.appendChild(btn);
        });
    }

    pickerMessage(icon, text) {
        const div = document.createElement('div');
        div.className = 'picker-message';
        const i = document.createElement('span');
        i.className = 'material-symbols-outlined';
        i.textContent = icon;
        const p = document.createElement('p');
        p.textContent = text;
        div.append(i, p);
        return div;
    }

    updatePickerCount() {
        const n = this.picked.length;
        document.getElementById('pickerCount').textContent = n ? `${n} of 4 picked` : 'Pick up to 4 photos';
        document.getElementById('pickerDone').textContent = n ? 'Use photos' : 'No photos';
    }

    // ---------- Toasts ----------------------------------------------

    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.textContent = type === 'error' ? 'error' : type === 'success' ? 'check_circle' : 'info';
        const text = document.createElement('span');
        text.className = 'toast-message';
        text.textContent = message;
        toast.append(icon, text);
        container.appendChild(toast);

        setTimeout(() => toast.classList.add('show'), 100);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

/**
 * Admin Notes page: list, write and schedule the note pages the slideshow
 * slips in between photos. The preview uses the same NotePage renderer as
 * the frame, so what you see here is what the frame shows.
 */
class NotesManager {
    constructor() {
        this.notes = [];
        this.accounts = [];
        this.editing = null;      // note being edited, or null for a new one
        this.photos = [];         // [{ path, url, thumbnail }] in the editor
        this.picked = [];         // selection inside the photo picker
        this.pickerPath = 'uploads';
        this.audience = { all: true, accountIds: [] };
        this.layout = 'auto';
        this.deleting = null;
        this.form = document.getElementById('noteForm');
        this.init();
    }

    init() {
        this.renderLayoutPicker();
        this.bindEvents();
        this.loadNotes();
        this.loadAccounts();
    }

    bindEvents() {
        document.getElementById('createNoteBtn').addEventListener('click', () => this.openEditor());
        document.getElementById('closeNoteModal').addEventListener('click', () => this.closeEditor());
        document.getElementById('cancelNoteBtn').addEventListener('click', () => this.closeEditor());

        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveNote();
        });
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

        document.getElementById('cancelDeleteBtn').addEventListener('click', () => document.getElementById('deleteModal').close());
        document.getElementById('confirmDeleteBtn').addEventListener('click', () => this.deleteNote());

        // The preview's countdown ("In 40 min") stays current while the editor is open
        setInterval(() => {
            if (document.getElementById('noteModal').open) this.updatePreview();
        }, 60000);
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

    async loadNotes() {
        try {
            const { ok, data } = await this.api('/api/notes');
            if (!ok) throw new Error(data.error || 'Failed to load notes');
            this.notes = data.notes || [];
            this.renderList();
        } catch (error) {
            if (error.message !== 'Signed out') {
                this.showToast('Could not load notes', 'error');
                document.getElementById('loadingState').classList.add('hidden');
            }
        }
    }

    async loadAccounts() {
        try {
            const { ok, data } = await this.api('/api/access-accounts');
            if (ok) this.accounts = data.accounts || [];
        } catch (_) {
            this.accounts = [];
        }
        this.renderAudience();
        if (this.notes.length) this.renderList();
    }

    // ---------- List ------------------------------------------------

    renderList() {
        document.getElementById('loadingState').classList.add('hidden');
        const list = document.getElementById('notesList');
        const empty = document.getElementById('emptyState');
        list.replaceChildren();

        const counts = { active: 0, upcoming: 0 };
        this.notes.forEach(n => { if (counts[n.status] !== undefined) counts[n.status]++; });
        document.getElementById('notesMetaText').textContent = this.notes.length
            ? `${counts.active} showing now · ${counts.upcoming} upcoming · ${this.notes.length} in total`
            : 'No notes yet';

        if (!this.notes.length) {
            list.classList.add('hidden');
            empty.classList.remove('hidden');
            this.renderEmptyExample();
            return;
        }
        empty.classList.add('hidden');
        list.classList.remove('hidden');

        const groups = [
            ['active', 'Showing now'],
            ['upcoming', 'Upcoming'],
            ['paused', 'Paused'],
            ['ended', 'Ended']
        ];
        let index = 0;
        groups.forEach(([status, label]) => {
            const notes = this.notes
                .filter(n => n.status === status)
                .sort((a, b) => new Date(a.eventAt || a.startsAt) - new Date(b.eventAt || b.startsAt));
            if (!notes.length) return;

            const section = document.createElement('section');
            section.className = `notes-group group-${status}`;
            const heading = document.createElement('h2');
            heading.className = 'notes-group-title sora-eyebrow';
            heading.textContent = `${label} · ${notes.length}`;
            section.appendChild(heading);

            const grid = document.createElement('div');
            grid.className = 'notes-grid';
            notes.forEach(note => grid.appendChild(this.noteCard(note, index++)));
            section.appendChild(grid);
            list.appendChild(section);
        });
    }

    noteCard(note, index) {
        const card = document.createElement('article');
        card.className = `note-card status-${note.status}`;
        card.style.animationDelay = `${Math.min(index, 8) * 50}ms`;

        const stage = document.createElement('button');
        stage.type = 'button';
        stage.className = 'note-stage note-card-preview';
        stage.title = 'Edit note';
        stage.appendChild(NotePage.render({ ...note, photos: note.photoUrls.map(p => p.thumbnail) }));
        stage.addEventListener('click', () => this.openEditor(note));
        card.appendChild(stage);

        const body = document.createElement('div');
        body.className = 'note-card-body';

        const top = document.createElement('div');
        top.className = 'note-card-top';
        const title = document.createElement('h3');
        title.className = 'note-card-title';
        title.textContent = note.title;
        top.appendChild(title);

        const toggle = document.createElement('label');
        toggle.className = 'note-toggle';
        toggle.title = note.enabled ? 'Pause this note' : 'Resume this note';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('role', 'switch');
        checkbox.className = 'input';
        checkbox.checked = note.enabled;
        checkbox.setAttribute('aria-label', note.enabled ? 'Showing; pause note' : 'Paused; resume note');
        checkbox.addEventListener('change', () => this.setEnabled(note, checkbox.checked, checkbox));
        toggle.appendChild(checkbox);
        top.appendChild(toggle);
        body.appendChild(top);

        const meta = document.createElement('ul');
        meta.className = 'note-card-meta';
        [
            ['schedule', this.scheduleSummary(note)],
            ['repeat', `Every ${this.minutesLabel(note.everyMinutes)} · ${note.showForSeconds}s`],
            ['devices', this.audienceSummary(note)]
        ].forEach(([icon, text]) => {
            const li = document.createElement('li');
            const i = document.createElement('span');
            i.className = 'material-symbols-outlined';
            i.textContent = icon;
            const t = document.createElement('span');
            t.textContent = text;
            li.append(i, t);
            meta.appendChild(li);
        });
        body.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'note-card-actions';
        actions.append(
            this.iconButton('edit', 'Edit', () => this.openEditor(note)),
            this.iconButton('delete', 'Delete', () => this.confirmDelete(note))
        );
        body.appendChild(actions);

        card.appendChild(body);
        return card;
    }

    iconButton(icon, label, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-sm-ghost';
        btn.title = label;
        const i = document.createElement('span');
        i.className = 'material-symbols-outlined';
        i.textContent = icon;
        const t = document.createElement('span');
        t.textContent = label;
        btn.append(i, t);
        btn.addEventListener('click', onClick);
        return btn;
    }

    scheduleSummary(note) {
        const fmt = d => new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
        const end = note.endsAt || (note.eventAt ? new Date(new Date(note.eventAt).getTime() + 2 * 3600000).toISOString() : null);
        if (note.status === 'upcoming') return `Starts ${fmt(note.startsAt)}`;
        if (note.status === 'ended') return `Ended ${fmt(end)}`;
        if (note.eventAt) return `Event ${fmt(note.eventAt)}`;
        return end ? `Until ${fmt(end)}` : 'No end date';
    }

    minutesLabel(minutes) {
        return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
    }

    audienceSummary(note) {
        if (note.audience?.all !== false) return 'All frames';
        const names = (note.audience.accountIds || [])
            .map(id => this.accounts.find(a => a.id === id)?.name)
            .filter(Boolean);
        if (!names.length) return `${note.audience.accountIds.length} frame(s)`;
        return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
    }

    renderEmptyExample() {
        const stage = document.getElementById('emptyPreview');
        const inThreeDays = new Date();
        inThreeDays.setDate(inThreeDays.getDate() + 3);
        inThreeDays.setHours(17, 0, 0, 0);
        stage.replaceChildren(NotePage.render({
            title: 'Ambika is visiting you',
            message: "She's bringing the kids and your favourite cake.",
            signoff: 'Love, Ambika',
            eventAt: inThreeDays.toISOString(),
            theme: 'paper'
        }));
    }

    async setEnabled(note, enabled, checkbox) {
        checkbox.disabled = true;
        try {
            const { ok, data } = await this.api(`/api/notes/${encodeURIComponent(note.id)}`, {
                method: 'PUT',
                body: JSON.stringify({ enabled })
            });
            if (!ok) throw new Error(data.error || 'Could not update the note');
            this.showToast(enabled ? 'Note resumed' : 'Note paused', 'success');
            await this.loadNotes();
        } catch (error) {
            checkbox.checked = !enabled;
            checkbox.disabled = false;
            if (error.message !== 'Signed out') this.showToast(error.message, 'error');
        }
    }

    // ---------- Editor ----------------------------------------------

    openEditor(note = null) {
        this.editing = note;
        this.clearErrors();
        this.form.reset();
        document.getElementById('noteModalTitle').textContent = note ? 'Edit note' : 'New note';

        const f = this.form.elements;
        if (note) {
            f.title.value = note.title || '';
            f.message.value = note.message || '';
            f.signoff.value = note.signoff || '';
            f.eyebrow.value = note.eyebrow || '';
            f.eventAt.value = this.toLocalInput(note.eventAt);
            f.startsAt.value = this.toLocalInput(note.startsAt);
            f.endsAt.value = this.toLocalInput(note.endsAt);
            this.selectValue(f.everyMinutes, note.everyMinutes);
            this.selectValue(f.showForSeconds, note.showForSeconds);
            this.form.querySelector(`input[name="theme"][value="${note.theme || 'paper'}"]`).checked = true;
            this.photos = (note.photoUrls || []).map(p => ({ ...p }));
            this.layout = note.layout || 'auto';
            this.audience = {
                all: note.audience?.all !== false,
                accountIds: [...(note.audience?.accountIds || [])]
            };
        } else {
            f.startsAt.value = this.toLocalInput(new Date().toISOString());
            this.photos = [];
            this.layout = 'auto';
            this.audience = { all: true, accountIds: [] };
        }

        this.renderPhotoTiles();
        this.renderAudience();
        this.updatePreview();
        document.getElementById('noteModal').showModal();
        f.title.focus();
    }

    closeEditor() {
        document.getElementById('noteModal').close();
        this.editing = null;
    }

    // Selects keep their fixed options; add the stored value if it isn't one of them
    selectValue(select, value) {
        const v = String(value);
        if (![...select.options].some(o => o.value === v)) {
            const option = document.createElement('option');
            option.value = v;
            option.textContent = select.name === 'everyMinutes' ? `${v} min` : `${v} sec`;
            select.appendChild(option);
        }
        select.value = v;
    }

    readForm() {
        const f = this.form.elements;
        return {
            title: f.title.value,
            message: f.message.value,
            signoff: f.signoff.value,
            eyebrow: f.eyebrow.value,
            eventAt: this.fromLocalInput(f.eventAt.value),
            startsAt: this.fromLocalInput(f.startsAt.value),
            endsAt: this.fromLocalInput(f.endsAt.value),
            everyMinutes: Number(f.everyMinutes.value),
            showForSeconds: Number(f.showForSeconds.value),
            theme: this.form.querySelector('input[name="theme"]:checked')?.value || 'paper',
            photos: this.photos.map(p => p.path),
            layout: this.layout,
            audience: { ...this.audience }
        };
    }

    updatePreview() {
        const data = this.readForm();
        const f = this.form.elements;

        // With an event date the eyebrow counts down by itself, so its own field steps aside
        document.getElementById('eyebrowField').classList.toggle('is-muted', Boolean(data.eventAt));
        f.eyebrow.placeholder = data.eventAt ? NotePage.eyebrowFor(data) : 'This weekend';
        document.getElementById('endsHint').textContent = data.eventAt ? 'event + 2 h' : 'optional';

        ['title', 'message'].forEach(name => {
            const el = this.form.querySelector(`[data-count-for="${name}"]`);
            const left = Number(f[name].maxLength) - f[name].value.length;
            el.textContent = f[name].value.length ? String(left) : '';
            el.classList.toggle('is-low', left <= 10);
        });

        const previewNote = { ...data, photos: this.photos.map(p => p.thumbnail || p.url) };
        document.getElementById('notePreview').replaceChildren(NotePage.render(previewNote, { fill: true }));
        this.updateLayoutPicker(previewNote);
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

    async saveNote() {
        this.clearErrors();
        const payload = this.readForm();
        if (!payload.title.trim()) {
            this.showErrors({ title: 'Give the note a headline' });
            return;
        }

        const btn = document.getElementById('saveNoteBtn');
        btn.disabled = true;
        try {
            const url = this.editing ? `/api/notes/${encodeURIComponent(this.editing.id)}` : '/api/notes';
            const { ok, data } = await this.api(url, {
                method: this.editing ? 'PUT' : 'POST',
                body: JSON.stringify(payload)
            });
            if (!ok) {
                if (data.errors) this.showErrors(data.errors);
                throw new Error(data.error || 'Could not save the note');
            }
            this.showToast(this.editing ? 'Note updated' : 'Note saved', 'success');
            this.closeEditor();
            await this.loadNotes();
        } catch (error) {
            if (error.message !== 'Signed out') this.showToast(error.message, 'error');
        } finally {
            btn.disabled = false;
        }
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

    // datetime-local works in local time without a zone; the API stores ISO strings
    toLocalInput(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    fromLocalInput(value) {
        if (!value) return null;
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
                    this.showToast('A note holds up to 4 photos', 'info');
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

    // ---------- Audience --------------------------------------------

    renderAudience() {
        const wrap = document.getElementById('audienceChips');
        wrap.replaceChildren();

        const chip = (label, icon, active, onClick) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'nf-chip';
            btn.classList.toggle('is-on', active);
            btn.setAttribute('aria-pressed', String(active));
            const i = document.createElement('span');
            i.className = 'material-symbols-outlined';
            i.textContent = active ? 'check' : icon;
            const t = document.createElement('span');
            t.textContent = label;
            btn.append(i, t);
            btn.addEventListener('click', () => {
                onClick();
                this.renderAudience();
                this.form.querySelector('[data-error-for="audience"]').textContent = '';
            });
            wrap.appendChild(btn);
        };

        chip('All frames', 'devices', this.audience.all, () => {
            this.audience = { all: true, accountIds: [] };
        });
        this.accounts.forEach(account => {
            const on = !this.audience.all && this.audience.accountIds.includes(account.id);
            chip(account.name, 'key', on, () => {
                const ids = new Set(this.audience.all ? [] : this.audience.accountIds);
                if (ids.has(account.id)) ids.delete(account.id); else ids.add(account.id);
                this.audience = ids.size ? { all: false, accountIds: [...ids] } : { all: true, accountIds: [] };
            });
        });

        if (!this.accounts.length) {
            const hint = document.createElement('span');
            hint.className = 'nf-hint';
            hint.textContent = 'Add access accounts to target a single frame';
            wrap.appendChild(hint);
        }
    }

    // ---------- Delete ----------------------------------------------

    confirmDelete(note) {
        this.deleting = note;
        document.getElementById('deleteNoteName').textContent = note.title;
        document.getElementById('deleteModal').showModal();
    }

    async deleteNote() {
        if (!this.deleting) return;
        const btn = document.getElementById('confirmDeleteBtn');
        btn.disabled = true;
        try {
            const { ok, data } = await this.api(`/api/notes/${encodeURIComponent(this.deleting.id)}`, { method: 'DELETE' });
            if (!ok) throw new Error(data.error || 'Could not delete the note');
            this.showToast('Note deleted', 'success');
            document.getElementById('deleteModal').close();
            this.deleting = null;
            await this.loadNotes();
        } catch (error) {
            if (error.message !== 'Signed out') this.showToast(error.message, 'error');
        } finally {
            btn.disabled = false;
        }
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

document.addEventListener('DOMContentLoaded', () => {
    window.notesManager = new NotesManager();
});

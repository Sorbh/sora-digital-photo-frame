/**
 * Admin Notes page: list, write and schedule the note pages the slideshow
 * slips in between photos. The preview uses the same NotePage renderer as
 * the frame, so what you see here is what the frame shows.
 *
 * Each note is a file in a library folder. Notes in the top folder show on
 * every frame; a note in another folder shows on the frames that show it.
 *
 *   /notes?folder=uploads/Family                 new notes go into Family
 *   /notes?folder=uploads/Family&edit=<path>     opens that note's editor
 *   /notes?folder=uploads/Family&new=1           opens the editor for a new note in Family
 *
 * Opened for one note from the library (edit= or new=1, its "New note" button),
 * the page goes back to that library folder once the note is saved or closed.
 */
const TOP_FOLDER = 'uploads';
const STATUS_ORDER = ['active', 'upcoming', 'paused', 'ended'];

class NotesManager extends PageEditor {
    constructor() {
        super(document.getElementById('noteForm'), 'note');
        const params = new URLSearchParams(window.location.search);
        this.notes = [];
        this.folders = [TOP_FOLDER];
        this.cameFrom = params.get('folder') || TOP_FOLDER;  // the library folder this page was opened from
        this.pendingEdit = params.get('edit');                // a note to open once the list is in
        this.pendingNew = params.get('new') === '1';          // a new note to start once the list is in
        this.backToLibrary = Boolean(this.pendingEdit || this.pendingNew);
        this.editing = null;      // note being edited, or null for a new one
        this.deleting = null;
        this.init();
    }

    init() {
        this.renderLayoutPicker();
        this.renderScheduleControls();
        this.bindEvents();
        const back = this.cameFrom === TOP_FOLDER ? '/home' : `/home?${new URLSearchParams({ path: this.cameFrom })}`;
        document.getElementById('backLink').href = back;
        // Until the list arrives: the top folder and the one this page came from
        this.folders = [...new Set([TOP_FOLDER, this.cameFrom])];
        this.renderFolderSelect();
        this.pickerPath = this.cameFrom; // photos are chosen starting in that folder too
        this.loadNotes();
    }

    bindEvents() {
        this.bindEditorEvents();
        document.getElementById('createNoteBtn').addEventListener('click', () => this.openEditor());
        document.getElementById('closeNoteModal').addEventListener('click', () => this.closeEditor());
        document.getElementById('cancelNoteBtn').addEventListener('click', () => this.closeEditor());
        // However the editor closes (Save, Cancel, Escape): back to the library when it came from there
        document.getElementById('noteModal').addEventListener('close', () => {
            if (this.backToLibrary) window.location.href = document.getElementById('backLink').href;
        });

        this.form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveNote();
        });

        document.getElementById('cancelDeleteBtn').addEventListener('click', () => document.getElementById('deleteModal').close());
        document.getElementById('confirmDeleteBtn').addEventListener('click', () => this.deleteNote());

        // The preview's countdown ("In 40 min") stays current while the editor is open
        setInterval(() => {
            if (document.getElementById('noteModal').open) this.updatePreview();
        }, 60000);
        window.addEventListener('sora:languagechange', () => {
            this.renderLayoutPicker();
            this.renderScheduleControls();
            this.renderFolderSelect();
            if (this.loaded) this.renderList();
            this.renderDeleteText();
            const modal = document.getElementById('noteModal');
            if (modal.open) {
                this.renderModalTitle();
                this.renderPhotoTiles();
                this.updatePreview();
            }
        });
    }

    async loadNotes() {
        try {
            const { ok, data } = await this.api('/api/notes');
            if (!ok) throw new Error(i18n.error(data, 'notes.loadFailed'));
            this.notes = data.notes || [];
            this.folders = data.folders?.length ? data.folders : [TOP_FOLDER];
            this.loaded = true;
            this.renderFolderSelect();
            this.renderList();
            this.openPendingEdit();
        } catch (error) {
            if (error.message !== 'Signed out') {
                this.showToast(t('notes.loadFailed'), 'error');
                document.getElementById('loadingState').classList.add('hidden');
            }
        }
    }

    // Opened from the library: a note's editor (its tile), or a new one ("New note"), once
    openPendingEdit() {
        if (this.pendingNew) {
            this.pendingNew = false;
            this.openEditor();
            return;
        }
        if (!this.pendingEdit) return;
        const note = this.notes.find(n => n.path === this.pendingEdit);
        this.pendingEdit = null;
        if (note) this.openEditor(note);
        else this.backToLibrary = false; // gone meanwhile: this is the Notes page as usual
    }

    // ---------- Folders ---------------------------------------------

    // "Top folder (all frames)", or the folder's path below the library: "Family / Beach"
    folderLabel(folder) {
        if (!folder || folder === TOP_FOLDER) return t('notes.topFolder');
        return folder.split('/').slice(1).join(' / ');
    }

    // New notes go into the folder this page was opened from, when it can hold them
    defaultFolder() {
        return this.folders.includes(this.cameFrom) ? this.cameFrom : (this.folders[0] || TOP_FOLDER);
    }

    renderFolderSelect() {
        const select = document.getElementById('noteFolder');
        const current = select.value;
        select.replaceChildren(...this.folders.map(folder => {
            const option = document.createElement('option');
            option.value = folder;
            option.textContent = this.folderLabel(folder);
            return option;
        }));
        if (current && this.folders.includes(current)) select.value = current;
    }

    folderSummary(note) {
        return note.folder === TOP_FOLDER ? t('notes.allFrames') : t('notes.framesShowingFolder', { folder: this.folderLabel(note.folder) });
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
            ? t('notes.metaSummary', { active: counts.active, upcoming: counts.upcoming, total: this.notes.length })
            : t('notes.noNotes');

        if (!this.notes.length) {
            list.classList.add('hidden');
            empty.classList.remove('hidden');
            this.renderEmptyExample();
            return;
        }
        empty.classList.add('hidden');
        list.classList.remove('hidden');

        // One group per folder: the top folder first, then the folder this page came
        // from, then the rest by name. In each, showing now first, then by date.
        const folders = [...new Set(this.notes.map(n => n.folder))].sort((a, b) => {
            const rank = f => (f === TOP_FOLDER ? 0 : f === this.cameFrom ? 1 : 2);
            return rank(a) - rank(b) || a.localeCompare(b);
        });
        let index = 0;
        folders.forEach(folder => {
            const notes = this.notes
                .filter(n => n.folder === folder)
                .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
                    || new Date(a.eventAt || a.startsAt) - new Date(b.eventAt || b.startsAt));

            const section = document.createElement('section');
            section.className = 'notes-group';
            section.dataset.folder = folder;
            const heading = document.createElement('h2');
            heading.className = 'notes-group-title sora-eyebrow';
            heading.textContent = t('notes.groupHeading', { label: this.folderLabel(folder), total: notes.length });
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
        stage.title = t('notes.editNote');
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
        toggle.title = note.enabled ? t('notes.pauseNote') : t('notes.resumeNote');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('role', 'switch');
        checkbox.className = 'input';
        checkbox.checked = note.enabled;
        checkbox.setAttribute('aria-label', note.enabled ? t('notes.pauseNoteLabel') : t('notes.resumeNoteLabel'));
        checkbox.addEventListener('change', () => this.setEnabled(note, checkbox.checked, checkbox));
        toggle.appendChild(checkbox);
        top.appendChild(toggle);
        body.appendChild(top);

        const meta = document.createElement('ul');
        meta.className = 'note-card-meta';
        [
            ['schedule', this.scheduleSummary(note)],
            ['repeat', t('notes.repeatSummary', { interval: this.minutesLabel(note.everyMinutes), seconds: note.showForSeconds })],
            ['folder', this.folderSummary(note)]
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
            this.iconButton('edit', t('common.edit'), () => this.openEditor(note)),
            this.iconButton('delete', t('common.delete'), () => this.confirmDelete(note))
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
            const fmt = d => new Date(d).toLocaleString(window.i18n?.locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
        const end = note.endsAt || (note.eventAt ? new Date(new Date(note.eventAt).getTime() + 2 * 3600000).toISOString() : null);
        if (note.status === 'upcoming') return t('notes.scheduleStarts', { date: fmt(note.startsAt) });
        if (note.status === 'ended') return t('notes.scheduleEnded', { date: fmt(end) });
        if (note.eventAt) return t('notes.scheduleEvent', { date: fmt(note.eventAt) });
        return end ? t('notes.scheduleUntil', { date: fmt(end) }) : t('notes.scheduleNoEnd');
    }

    minutesLabel(minutes) {
        return minutes >= 60 && minutes % 60 === 0 ? t('notes.everyHoursShort', { count: minutes / 60 }) : t('notes.everyMinutes', { count: minutes });
    }

    // Option text for the "Show every … for …" selects: "5 min", "1 hour", "20 sec"
    optionLabel(select, value) {
        const v = Number(value);
        if (select.name === 'everyMinutes') return v === 60 ? t('notes.everyHours', { count: 1 }) : t('notes.everyMinutes', { count: v });
        return v === 60 ? t('notes.everyMinutes', { count: 1 }) : t('notes.showSeconds', { count: v });
    }

    // "Show every [5 min] for [20 sec]" is one sentence: the translation decides where the selects go
    renderScheduleControls() {
        // Kept from the first call: a sentence without a slot (the key itself, before
        // the language has loaded) must never take the selects out of the form
        const f = this.form.elements;
        this.scheduleSelects = this.scheduleSelects || { every: f.everyMinutes, duration: f.showForSeconds };
        const slots = this.scheduleSelects;
        Object.values(slots).forEach(select => {
            [...select.options].forEach(option => { option.textContent = this.optionLabel(select, option.value); });
        });
        const row = document.getElementById('showEveryRow');
        if (!row) return;
        const parts = t(row.dataset.i18nTemplate || 'notes.showEveryFor').split(/\{(\w+)\}/);
        const nodes = [];
        parts.forEach((part, i) => {
            if (i % 2) {
                if (slots[part]) nodes.push(slots[part]);
                return;
            }
            const text = part.trim();
            if (!text) return;
            const label = document.createElement('span');
            label.className = 'nf-label';
            label.textContent = text;
            nodes.push(label);
        });
        Object.values(slots).forEach(select => { if (!nodes.includes(select)) nodes.push(select); });
        row.replaceChildren(...nodes);
    }

    renderEmptyExample() {
        const stage = document.getElementById('emptyPreview');
        const inThreeDays = new Date();
        inThreeDays.setDate(inThreeDays.getDate() + 3);
        inThreeDays.setHours(17, 0, 0, 0);
        stage.replaceChildren(NotePage.render({
            title: t('notes.static_026'),
            message: t('notes.static_027'),
            signoff: t('notes.static_028'),
            eventAt: inThreeDays.toISOString(),
            theme: 'paper'
        }));
    }

    async setEnabled(note, enabled, checkbox) {
        checkbox.disabled = true;
        try {
            const { ok, data } = await this.api(`/api/notes?${new URLSearchParams({ path: note.path })}`, {
                method: 'PUT',
                body: JSON.stringify({ enabled })
            });
            if (!ok) throw new Error(i18n.error(data, 'notes.updateFailed'));
            this.showToast(enabled ? t('notes.noteResumed') : t('notes.notePaused'), 'success');
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
        this.renderModalTitle();

        const f = this.form.elements;
        if (note) {
            this.fillPage(note);
            f.eventAt.value = this.toLocalInput(note.eventAt);
            f.startsAt.value = this.toLocalInput(note.startsAt);
            f.endsAt.value = this.toLocalInput(note.endsAt);
            this.selectValue(f.everyMinutes, note.everyMinutes);
            this.selectValue(f.showForSeconds, note.showForSeconds);
            f.folder.value = note.folder;
        } else {
            f.startsAt.value = this.toLocalInput(new Date().toISOString());
            this.photos = [];
            this.layout = 'auto';
            f.folder.value = this.defaultFolder();
        }

        this.renderPhotoTiles();
        this.updatePreview();
        document.getElementById('noteModal').showModal();
        f.title.focus();
    }

    renderModalTitle() {
        const title = document.getElementById('noteModalTitle');
        title.removeAttribute('data-i18n'); // "New note" or "Edit note", set here
        title.textContent = this.editing ? t('notes.editNote') : t('notes.static_008');
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
            option.textContent = this.optionLabel(select, v);
            select.appendChild(option);
        }
        select.value = v;
    }

    readForm() {
        const f = this.form.elements;
        return {
            ...this.readPage(),
            eventAt: this.fromLocalInput(f.eventAt.value),
            startsAt: this.fromLocalInput(f.startsAt.value),
            endsAt: this.fromLocalInput(f.endsAt.value),
            everyMinutes: Number(f.everyMinutes.value),
            showForSeconds: Number(f.showForSeconds.value),
            folder: f.folder.value || TOP_FOLDER
        };
    }

    updatePreview() {
        const data = this.readForm();

        // With an event date the eyebrow counts down by itself, so its own field steps aside
        document.getElementById('eyebrowField').classList.toggle('is-muted', Boolean(data.eventAt));
        this.form.elements.eyebrow.placeholder = data.eventAt ? NotePage.eyebrowFor(data) : t('notes.static_030');
        document.getElementById('endsHint').textContent = data.eventAt ? t('notes.endsAfterEvent') : t('notes.optional');
        super.updatePreview();
    }

    async saveNote() {
        this.clearErrors();
        const payload = this.readForm();
        if (!payload.title.trim()) {
            this.showErrors({ title: t('notes.headlineRequired') });
            return;
        }

        const btn = document.getElementById('saveNoteBtn');
        btn.disabled = true;
        try {
            const url = this.editing ? `/api/notes?${new URLSearchParams({ path: this.editing.path })}` : '/api/notes';
            const { ok, data } = await this.api(url, {
                method: this.editing ? 'PUT' : 'POST',
                body: JSON.stringify(payload)
            });
            if (!ok) {
                if (data.errors) this.showErrors(data.errors);
                throw new Error(i18n.error(data, 'notes.saveFailed'));
            }
            this.showToast(this.editing ? t('notes.noteUpdated') : t('notes.noteSaved'), 'success');
            this.closeEditor();
            await this.loadNotes();
        } catch (error) {
            if (error.message !== 'Signed out') this.showToast(error.message, 'error');
        } finally {
            btn.disabled = false;
        }
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

    // ---------- Delete ----------------------------------------------

    confirmDelete(note) {
        this.deleting = note;
        this.renderDeleteText();
        document.getElementById('deleteModal').showModal();
    }

    // One whole sentence with the note's headline inside it
    renderDeleteText() {
        if (!this.deleting) return;
        const escape = document.createElement('div');
        escape.textContent = this.deleting.title;
        document.getElementById('deleteNoteText').innerHTML = t('notes.deleteConfirm', { name: escape.innerHTML });
    }

    async deleteNote() {
        if (!this.deleting) return;
        const btn = document.getElementById('confirmDeleteBtn');
        btn.disabled = true;
        try {
            const { ok, data } = await this.api(`/api/notes?${new URLSearchParams({ path: this.deleting.path })}`, { method: 'DELETE' });
            if (!ok) throw new Error(i18n.error(data, 'notes.deleteFailed'));
            this.showToast(t('notes.noteDeleted'), 'success');
            document.getElementById('deleteModal').close();
            this.deleting = null;
            await this.loadNotes();
        } catch (error) {
            if (error.message !== 'Signed out') this.showToast(error.message, 'error');
        } finally {
            btn.disabled = false;
        }
    }

}

document.addEventListener('DOMContentLoaded', () => {
    window.notesManager = new NotesManager();
});

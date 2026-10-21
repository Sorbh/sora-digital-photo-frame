/**
 * Admin Notes page: list, write and schedule the note pages the slideshow
 * slips in between photos. The preview uses the same NotePage renderer as
 * the frame, so what you see here is what the frame shows.
 */
class NotesManager extends PageEditor {
    constructor() {
        super(document.getElementById('noteForm'), 'note');
        this.notes = [];
        this.accounts = [];
        this.editing = null;      // note being edited, or null for a new one
        this.audience = { all: true, accountIds: [] };
        this.deleting = null;
        this.init();
    }

    init() {
        this.renderLayoutPicker();
        this.bindEvents();
        this.loadNotes();
        this.loadAccounts();
    }

    bindEvents() {
        this.bindEditorEvents();
        document.getElementById('createNoteBtn').addEventListener('click', () => this.openEditor());
        document.getElementById('closeNoteModal').addEventListener('click', () => this.closeEditor());
        document.getElementById('cancelNoteBtn').addEventListener('click', () => this.closeEditor());

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
            this.fillPage(note);
            f.eventAt.value = this.toLocalInput(note.eventAt);
            f.startsAt.value = this.toLocalInput(note.startsAt);
            f.endsAt.value = this.toLocalInput(note.endsAt);
            this.selectValue(f.everyMinutes, note.everyMinutes);
            this.selectValue(f.showForSeconds, note.showForSeconds);
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
            ...this.readPage(),
            eventAt: this.fromLocalInput(f.eventAt.value),
            startsAt: this.fromLocalInput(f.startsAt.value),
            endsAt: this.fromLocalInput(f.endsAt.value),
            everyMinutes: Number(f.everyMinutes.value),
            showForSeconds: Number(f.showForSeconds.value),
            audience: { ...this.audience }
        };
    }

    updatePreview() {
        const data = this.readForm();

        // With an event date the eyebrow counts down by itself, so its own field steps aside
        document.getElementById('eyebrowField').classList.toggle('is-muted', Boolean(data.eventAt));
        this.form.elements.eyebrow.placeholder = data.eventAt ? NotePage.eyebrowFor(data) : 'This weekend';
        document.getElementById('endsHint').textContent = data.eventAt ? 'event + 2 h' : 'optional';
        super.updatePreview();
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

}

document.addEventListener('DOMContentLoaded', () => {
    window.notesManager = new NotesManager();
});

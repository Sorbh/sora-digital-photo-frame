/**
 * Decides when the slideshow should show a note instead of the next photo.
 * A note is due once `everyMinutes` have passed since this frame last showed
 * it. Never two notes in a row, and never before the first photo.
 */
class NoteScheduler {
    constructor() {
        this.notes = [];
        this.storageKey = 'sora.notes.lastShown';
        this.lastShown = this.loadLastShown();
        this.photosSinceNote = 0;
        this.refreshTimer = null;
    }

    loadLastShown() {
        try {
            return JSON.parse(localStorage.getItem(this.storageKey)) || {};
        } catch (_) {
            return {};
        }
    }

    saveLastShown() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.lastShown));
        } catch (_) { /* private mode: notes still rotate for this visit */ }
    }

    start() {
        this.refresh();
        clearInterval(this.refreshTimer);
        this.refreshTimer = setInterval(() => this.refresh(), 5 * 60 * 1000);
    }

    stop() {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }

    async refresh() {
        try {
            const response = await fetch('/api/notes/active');
            if (!response.ok) return;
            const data = await response.json();
            this.notes = data.notes || [];

            // Forget notes that are gone, so storage doesn't grow forever
            const ids = new Set(this.notes.map(n => n.id));
            Object.keys(this.lastShown).forEach(id => {
                if (!ids.has(id)) delete this.lastShown[id];
            });
            this.saveLastShown();
        } catch (error) {
            // Offline: keep showing the notes we already have
            console.warn('Could not refresh notes:', error);
        }
    }

    photoShown() {
        this.photosSinceNote++;
    }

    // The note to show now, or null. The one waiting longest goes first.
    nextDue(now = Date.now()) {
        if (this.photosSinceNote < 1) return null;

        const due = this.notes.filter(note => {
            if (note.endsAt && new Date(note.endsAt).getTime() <= now) return false;
            const last = this.lastShown[note.id] || 0;
            return now - last >= note.everyMinutes * 60 * 1000;
        });
        if (!due.length) return null;

        due.sort((a, b) => (this.lastShown[a.id] || 0) - (this.lastShown[b.id] || 0));
        return due[0];
    }

    markShown(note, now = Date.now()) {
        this.lastShown[note.id] = now;
        this.photosSinceNote = 0;
        this.saveLastShown();
    }
}

window.NoteScheduler = NoteScheduler;

/**
 * Renders a note as a memory-book page. Shared by the slideshow and the
 * admin preview, so what the admin sees is exactly what the frame shows.
 * All text goes in with textContent; notes never become HTML.
 */
const NotePage = {
    /**
     * Book layouts the admin can pick, modelled on memory-book spreads.
     * Each is a small tree: pages hold text pieces ('eyebrow', 'title',
     * 'message', 'signoff', 'foot'), photos ('p1'..'p4', ':2' = grow twice
     * as much), rows and columns. Nothing here is note-specific, so other
     * features (e.g. photo messages) can reuse the same layouts.
     */
    templates: {
        auto: { label: 'Auto', photos: 0 },
        cover: { label: 'Cover', photos: 1,
            book: ['title', 'message', 'p1', 'signoff', 'eyebrow'] },
        quote: { label: 'Quote', photos: 2,
            left: ['message', 'p1', 'signoff'],
            right: ['title', 'eyebrow', 'p2:2', 'foot'] },
        remember: { label: 'Remember', photos: 3,
            left: ['eyebrow', 'title', 'p1:2', { row: [{ col: ['message', 'signoff'] }, 'p3'] }],
            right: ['p2'], bleed: 'right' },
        stack: { label: 'Stack', photos: 3,
            left: ['title', 'p1'],
            right: [{ row: [{ col: ['eyebrow', 'message', 'signoff'] }, { col: ['p2', 'p3'] }] }] },
        collage: { label: 'Collage', photos: 4,
            left: [{ row: [{ col: ['eyebrow', 'title'] }, 'p1:2'] }, { row: ['p2', 'p3'] }],
            right: ['p4:2', 'message', 'signoff'] },
        spine: { label: 'Spine', photos: 4,
            left: [{ row: ['title', 'p1'] }],
            right: [{ row: [{ col: ['eyebrow', 'message', 'signoff'] }, { col: ['p2', 'p3', 'p4'] }] }],
            vertical: true },
        gallery: { label: 'Gallery', photos: 4,
            left: ['p1'],
            right: [{ row: [{ col: ['p2', 'p3', 'p4'] }, { col: ['eyebrow', 'title', 'message', 'signoff'] }] }],
            bleed: 'left' }
    },

    // Auto layout follows the number of photos: cover, split, mosaic or grid
    layoutFor(count) {
        if (count === 0) return 'cover';
        if (count === 1) return 'split';
        if (count <= 3) return 'mosaic';
        return 'grid';
    },

    /**
     * fill: draw empty slots for missing photos (the admin's layout picker).
     * Without it a book layout that lacks photos falls back to Auto.
     */
    render(note, { now = new Date(), fill = false } = {}) {
        const photos = (note.photos || []).slice(0, 4);
        let template = this.templates[note.layout] || this.templates.auto;
        if (template.photos > photos.length && !fill) template = this.templates.auto;

        const page = document.createElement('article');
        page.dataset.count = photos.length;

        const pieces = {
            eyebrow: ['p', 'np-eyebrow', this.eyebrowFor(note, now)],
            title: ['h2', 'np-title', note.title || 'Your headline'],
            message: ['p', 'np-message', note.message],
            signoff: ['p', 'np-signoff', note.signoff],
            foot: ['p', 'np-foot', 'Sora · Notes']
        };
        const textEl = (key) => {
            const [tag, className, value] = pieces[key];
            if (!value) return null;
            const el = document.createElement(tag);
            el.className = className;
            el.textContent = value;
            return el;
        };
        const photoEl = (index) => {
            const figure = document.createElement('figure');
            figure.style.setProperty('--i', index);
            const photo = photos[index];
            if (photo) {
                const img = document.createElement('img');
                img.alt = '';
                img.decoding = 'async';
                img.src = typeof photo === 'string' ? photo : photo.url;
                figure.appendChild(img);
            } else {
                figure.className = 'is-empty';
            }
            return figure;
        };

        if (template === this.templates.auto) {
            page.className = `note-page theme-${note.theme || 'paper'} layout-${this.layoutFor(photos.length)}`;
            page.classList.toggle('is-long', (note.title || '').length > 34);
            const text = document.createElement('div');
            text.className = 'np-text';
            ['eyebrow', 'title', 'message', 'signoff', 'foot'].forEach(key => {
                const el = textEl(key);
                if (el) text.appendChild(el);
            });
            page.appendChild(text);
            if (photos.length) {
                const grid = document.createElement('div');
                grid.className = 'np-photos';
                photos.forEach((_, i) => grid.appendChild(photoEl(i)));
                page.appendChild(grid);
            }
            return page;
        }

        const key = Object.keys(this.templates).find(k => this.templates[k] === template);
        page.className = `note-page theme-${note.theme || 'paper'} tpl tpl-${key}`;
        page.classList.toggle('is-long', (note.title || '').length > 34);
        if (template.bleed) page.classList.add(`bleed-${template.bleed}`);
        if (template.vertical) page.classList.add('has-vertical');

        let textIndex = 0;
        const build = (node, parent) => {
            if (typeof node === 'string') {
                const [name, grow] = node.split(':');
                let el;
                if (/^p\d$/.test(name)) {
                    el = photoEl(Number(name[1]) - 1);
                } else {
                    el = textEl(name);
                    if (el) el.style.setProperty('--t', textIndex++);
                }
                if (!el) return;
                if (grow) el.style.flexGrow = grow;
                parent.appendChild(el);
                return;
            }
            const box = document.createElement('div');
            box.className = node.row ? 'np-row' : 'np-col';
            (node.row || node.col).forEach(child => build(child, box));
            if (box.children.length) parent.appendChild(box);
        };

        const sides = template.book ? [['book', template.book]] : [['left', template.left], ['right', template.right]];
        sides.forEach(([side, nodes]) => {
            const sheet = document.createElement('div');
            sheet.className = `np-sheet np-${side}`;
            nodes.forEach(node => build(node, sheet));
            page.appendChild(sheet);
        });
        return page;
    },

    // Resolves once the page's photos are ready (or after a timeout), so it never fades in half-loaded
    whenLoaded(page, timeout = 5000) {
        const images = [...page.querySelectorAll('img')];
        const loads = images.map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
        }));
        return Promise.race([Promise.all(loads), new Promise(resolve => setTimeout(resolve, timeout))]);
    },

    /**
     * The small line above the headline. With an event date it counts down:
     * "In 3 days · Mon 5 PM", "Tomorrow · 5 PM", "Today · 5 PM", "In 40 min",
     * "Happening now". Otherwise the admin's own eyebrow text (if any).
     */
    eyebrowFor(note, now = new Date()) {
        if (!note.eventAt) return note.eyebrow || '';

        const event = new Date(note.eventAt);
        if (Number.isNaN(event.getTime())) return note.eyebrow || '';

        const minutes = Math.round((event - now) / 60000);
        if (minutes <= 0) return 'Happening now';
        if (minutes <= 60) return `In ${minutes} min`;

        const time = this.formatTime(event);
        const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const days = Math.round((startOfDay(event) - startOfDay(now)) / 86400000);

        if (days === 0) return `Today · ${time}`;
        if (days === 1) return `Tomorrow · ${time}`;
        if (days < 7) {
            const weekday = event.toLocaleDateString(undefined, { weekday: 'short' });
            return `In ${days} days · ${weekday} ${time}`;
        }
        const date = event.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
        return `${date} · ${time}`;
    },

    // "5 PM" on the hour, "5:30 PM" otherwise (or 17:00 in 24-hour locales)
    formatTime(date) {
        const options = { hour: 'numeric' };
        if (date.getMinutes() !== 0) options.minute = '2-digit';
        const time = date.toLocaleTimeString(undefined, options);
        // A bare "17" reads like a date; 24-hour locales get "17:00"
        return /^\d+$/.test(time.trim())
            ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
            : time;
    }
};

window.NotePage = NotePage;

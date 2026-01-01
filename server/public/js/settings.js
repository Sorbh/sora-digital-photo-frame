// Settings Manager
class SettingsManager {
    constructor() {
        this.settingsBtn = null;
        this.modal = null;
        this.init();
    }

    init() {
        this.injectModal();
        this.bindEvents();
        this.updateAllSettings();
    }

    injectModal() {
        const modalHTML = `
            <dialog id="settingsModal" class="dialog" aria-labelledby="settings-title">
                <article style="max-width: 500px;">
                    <header>
                        <h2 id="settings-title">Settings</h2>
                        <button id="closeSettingsModal" class="btn-sm-icon-ghost absolute top-4 right-4" aria-label="Close">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </header>
                    <section class="grid gap-6">
                        <!-- Weather Widget -->
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <span class="material-symbols-outlined text-2xl">wb_sunny</span>
                                <div>
                                    <div class="font-medium">Weather Widget</div>
                                    <div class="text-sm text-muted-foreground">Show clock and weather overlay</div>
                                </div>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="weatherWidgetToggle" checked>
                                <span class="slider"></span>
                            </label>
                        </div>

                        <!-- Date Display -->
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <span class="material-symbols-outlined text-2xl">calendar_today</span>
                                <div>
                                    <div class="font-medium">Date Display</div>
                                    <div class="text-sm text-muted-foreground">Show date below clock</div>
                                </div>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="dateDisplayToggle" checked>
                                <span class="slider"></span>
                            </label>
                        </div>

                        <!-- Time Format -->
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <span class="material-symbols-outlined text-2xl">schedule</span>
                                <div>
                                    <div class="font-medium">Time Format</div>
                                    <div class="text-sm text-muted-foreground">12-hour or 24-hour clock</div>
                                </div>
                            </div>
                            <div class="btn-group" role="group">
                                <button id="time12HrBtn" class="btn-sm" data-format="12">12h</button>
                                <button id="time24HrBtn" class="btn-sm" data-format="24">24h</button>
                            </div>
                        </div>

                        <!-- Temperature Unit -->
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-3">
                                <span class="material-symbols-outlined text-2xl">thermostat</span>
                                <div>
                                    <div class="font-medium">Temperature Unit</div>
                                    <div class="text-sm text-muted-foreground">Celsius or Fahrenheit</div>
                                </div>
                            </div>
                            <div class="btn-group" role="group">
                                <button id="tempCelsiusBtn" class="btn-sm" data-unit="C">°C</button>
                                <button id="tempFahrenheitBtn" class="btn-sm" data-unit="F">°F</button>
                            </div>
                        </div>

                        <!-- Widget Opacity -->
                        <div>
                            <div class="flex items-center gap-3 mb-2">
                                <span class="material-symbols-outlined text-2xl">opacity</span>
                                <div>
                                    <div class="font-medium">Widget Opacity</div>
                                    <div class="text-sm text-muted-foreground">Adjust overlay transparency</div>
                                </div>
                            </div>
                            <div class="flex items-center gap-3">
                                <input type="range" id="widgetOpacitySlider" min="0" max="100" value="100" class="flex-1" style="cursor: pointer;">
                                <span id="opacityValue" class="text-sm font-medium min-w-[3rem] text-right">100%</span>
                            </div>
                        </div>
                    </section>
                </article>
            </dialog>

            <style>
                /* Custom toggle switch */
                .switch {
                    position: relative;
                    display: inline-block;
                    width: 48px;
                    height: 24px;
                }

                .switch input {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }

                .slider {
                    position: absolute;
                    cursor: pointer;
                    inset: 0;
                    background-color: var(--muted);
                    transition: 0.3s;
                    border-radius: 24px;
                }

                .slider:before {
                    position: absolute;
                    content: "";
                    height: 18px;
                    width: 18px;
                    left: 3px;
                    bottom: 3px;
                    background-color: white;
                    transition: 0.3s;
                    border-radius: 50%;
                }

                .switch input:checked + .slider {
                    background-color: var(--primary);
                }

                .switch input:checked + .slider:before {
                    transform: translateX(24px);
                }

                .btn-group {
                    display: inline-flex;
                    border-radius: var(--radius);
                    overflow: hidden;
                    border: 1px solid var(--border);
                }

                .btn-group .btn-sm {
                    border-radius: 0;
                    border-left: 1px solid var(--border);
                    background-color: var(--background);
                    color: var(--muted-foreground);
                    font-weight: 500;
                    transition: all 0.2s ease;
                }

                .btn-group .btn-sm:first-child {
                    border-left: none;
                }

                .btn-group .btn-sm:hover:not(.active) {
                    background-color: var(--muted);
                }

                .btn-group .btn-sm.active {
                    background-color: var(--primary);
                    color: var(--primary-foreground);
                    font-weight: 600;
                    box-shadow: inset 0 0 0 1px var(--primary);
                }
            </style>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
        this.modal = document.getElementById('settingsModal');
    }

    bindEvents() {
        // Settings button (will be set from admin)
        document.addEventListener('click', (e) => {
            if (e.target.closest('#settingsBtn')) {
                this.openModal();
            }
        });

        // Close button
        document.getElementById('closeSettingsModal').addEventListener('click', () => {
            this.closeModal();
        });

        // Close on backdrop click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });

        // Weather widget toggle
        document.getElementById('weatherWidgetToggle').addEventListener('change', (e) => {
            const enabled = e.target.checked;
            localStorage.setItem('weatherWidgetEnabled', enabled.toString());
            this.showToast(`Weather widget ${enabled ? 'enabled' : 'disabled'}`, 'success');
        });

        // Date display toggle
        document.getElementById('dateDisplayToggle').addEventListener('change', (e) => {
            const enabled = e.target.checked;
            localStorage.setItem('dateDisplayEnabled', enabled.toString());
            this.showToast(`Date display ${enabled ? 'enabled' : 'disabled'}`, 'success');
        });

        // Time format buttons
        document.getElementById('time12HrBtn').addEventListener('click', () => {
            this.setTimeFormat('12');
        });

        document.getElementById('time24HrBtn').addEventListener('click', () => {
            this.setTimeFormat('24');
        });

        // Temperature unit buttons
        document.getElementById('tempCelsiusBtn').addEventListener('click', () => {
            this.setTempUnit('C');
        });

        document.getElementById('tempFahrenheitBtn').addEventListener('click', () => {
            this.setTempUnit('F');
        });

        // Widget opacity slider
        const opacitySlider = document.getElementById('widgetOpacitySlider');
        const opacityValue = document.getElementById('opacityValue');
        
        opacitySlider.addEventListener('input', (e) => {
            const opacity = e.target.value;
            opacityValue.textContent = `${opacity}%`;
            localStorage.setItem('widgetOpacity', opacity);
        });
    }

    setTempUnit(unit) {
        localStorage.setItem('temperatureUnit', unit);
        this.updateTempUnitButtons();
        this.showToast(`Temperature unit: °${unit}`, 'success');
    }

    setTimeFormat(format) {
        localStorage.setItem('timeFormat', format);
        this.updateTimeFormatButtons();
        this.showToast(`Time format: ${format}-hour`, 'success');
    }

    updateAllSettings() {
        // Weather widget
        const weatherEnabled = localStorage.getItem('weatherWidgetEnabled') !== 'false';
        document.getElementById('weatherWidgetToggle').checked = weatherEnabled;

        // Date display
        const dateEnabled = localStorage.getItem('dateDisplayEnabled') !== 'false';
        document.getElementById('dateDisplayToggle').checked = dateEnabled;

        // Time format
        this.updateTimeFormatButtons();

        // Temperature unit
        this.updateTempUnitButtons();

        // Widget opacity
        const opacity = localStorage.getItem('widgetOpacity') || '100';
        document.getElementById('widgetOpacitySlider').value = opacity;
        document.getElementById('opacityValue').textContent = `${opacity}%`;
    }

    updateTempUnitButtons() {
        const unit = localStorage.getItem('temperatureUnit') || 'C';
        const celsiusBtn = document.getElementById('tempCelsiusBtn');
        const fahrenheitBtn = document.getElementById('tempFahrenheitBtn');

        if (unit === 'C') {
            celsiusBtn.classList.add('active');
            fahrenheitBtn.classList.remove('active');
        } else {
            fahrenheitBtn.classList.add('active');
            celsiusBtn.classList.remove('active');
        }
    }

    updateTimeFormatButtons() {
        const format = localStorage.getItem('timeFormat') || '24';
        const hour12Btn = document.getElementById('time12HrBtn');
        const hour24Btn = document.getElementById('time24HrBtn');

        if (format === '12') {
            hour12Btn.classList.add('active');
            hour24Btn.classList.remove('active');
        } else {
            hour24Btn.classList.add('active');
            hour12Btn.classList.remove('active');
        }
    }

    openModal() {
        this.updateAllSettings();
        this.modal.showModal();
    }

    closeModal() {
        this.modal.close();
    }

    showToast(message, type = 'info') {
        const categoryMap = {
            'info': 'info',
            'success': 'success',
            'error': 'error',
            'warning': 'warning'
        };

        const category = categoryMap[type] || 'info';
        const titleMap = {
            'success': 'Success!',
            'error': 'Error!',
            'warning': 'Warning!',
            'info': 'Info'
        };

        const title = titleMap[type] || 'Notification';

        document.dispatchEvent(new CustomEvent('basecoat:toast', {
            detail: {
                config: {
                    category: category,
                    title: title,
                    description: message,
                    duration: 5000
                }
            }
        }));
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.settingsManager = new SettingsManager();
});

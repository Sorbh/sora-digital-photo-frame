// A short description of the browser for pairing and device sign-in.
(function (root) {
    // TVs first: many say "Android" too, without "Mobile"
    const TVS = [
        [/CrKey/i, 'Chromecast'],
        [/\bAFT[A-Z0-9]|Fire ?TV/i, 'Fire TV'],
        [/Tizen/i, 'Tizen'],
        [/Web0S|webOS|NetCast/i, 'webOS'],
        [/Android ?TV|GoogleTV|BRAVIA/i, 'Android TV'],
        [/Roku/i, 'Roku'],
        [/AppleTV|tvOS/i, 'Apple TV'],
        [/SMART-?TV|SmartTV|HbbTV|\bTV\b/i, 'Smart TV']
    ];

    function identifyPlatform(ua, touchPoints) {
        for (const [pattern, platform] of TVS) {
            if (pattern.test(ua)) return { kind: 'tv', platform };
        }
        if (/iPad/.test(ua)) return { kind: 'tablet', platform: 'iPadOS' };
        // iPadOS asks for desktop sites: a Mac with a touch screen is an iPad
        if (/Macintosh/.test(ua) && touchPoints > 1) return { kind: 'tablet', platform: 'iPadOS' };
        if (/iPhone|iPod/.test(ua)) return { kind: 'phone', platform: 'iOS' };
        if (/Android/i.test(ua)) {
            // Android phones say "Mobile"; tablets (Kindle Fire is "KF…") don't
            return { kind: /Mobile/i.test(ua) && !/\bKF[A-Z]{2,}/.test(ua) ? 'phone' : 'tablet', platform: 'Android' };
        }
        if (/Windows Phone|Mobile/i.test(ua)) return { kind: 'phone', platform: 'Web' };
        if (/CrOS/.test(ua)) return { kind: 'browser', platform: 'ChromeOS' };
        if (/Windows/.test(ua)) return { kind: 'browser', platform: 'Windows' };
        if (/Macintosh|Mac OS X/.test(ua)) return { kind: 'browser', platform: 'Mac' };
        if (/Linux/.test(ua)) return { kind: 'browser', platform: 'Linux' };
        return { kind: 'browser', platform: 'Web' };
    }

    function browserLabel(ua, brands) {
        if (/Edg(?:e|A|iOS)?\//i.test(ua)) return 'Edge';
        if (/OPR\/|OPiOS\/|Opera\//i.test(ua)) return 'Opera';
        if (/SamsungBrowser\//i.test(ua)) return 'Samsung Internet';
        if (/Silk\//i.test(ua)) return 'Silk';
        if (/Firefox\/|FxiOS\//i.test(ua)) return 'Firefox';
        if (brands?.some(entry => entry.brand === 'Brave')) return 'Brave';
        if (/\bwv\).*Chrome\//i.test(ua)) return 'WebView';
        if (/Chromium\//i.test(ua)) return 'Chromium';
        if (/Chrome\/|CriOS\//i.test(ua)) return 'Chrome';
        if (/Version\/.*Safari\//i.test(ua)) return 'Safari';
        return '';
    }

    function describe(userAgent, { touchPoints = 0, brands, model } = {}) {
        const ua = String(userAgent || '');
        const { kind, platform } = identifyPlatform(ua, touchPoints);
        const browser = browserLabel(ua, brands);
        const hardware = typeof model === 'string' && model.trim();
        return {
            kind,
            platform: browser ? `${platform} · ${browser}` : platform,
            ...(hardware && { model: hardware })
        };
    }

    async function advertise(navigator) {
        const { userAgent, maxTouchPoints, userAgentData } = navigator || {};
        let hints;
        try {
            hints = await userAgentData?.getHighEntropyValues?.(['model', 'platformVersion']);
        } catch {
            // The browser can deny access to these hints.
        }
        return describe(userAgent, { touchPoints: maxTouchPoints, brands: userAgentData?.brands, model: hints?.model });
    }

    root.SoraDevice = { describe, advertise };
    if (typeof module === 'object' && module.exports) module.exports = { describe, advertise };
})(typeof window !== 'undefined' ? window : globalThis);

// What this browser is, told to the server when it asks for a pairing code
// (POST /api/pair/start), so "Sora Frame nearby" can say "Android TV" beside the
// code. A rough guess from the user agent, and only a hint: nothing depends on it.
//
//   SoraDevice.describe(userAgent, { touchPoints }) -> { kind, platform }
//   kind: 'tv' | 'phone' | 'tablet' | 'browser'; platform: a short label
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

    function describe(userAgent, { touchPoints = 0 } = {}) {
        const ua = String(userAgent || '');
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
        if (/Macintosh|Mac OS X/.test(ua)) return { kind: 'browser', platform: 'macOS' };
        if (/Linux/.test(ua)) return { kind: 'browser', platform: 'Linux' };
        return { kind: 'browser', platform: 'Web' };
    }

    root.SoraDevice = { describe };
    if (typeof module === 'object' && module.exports) module.exports = { describe };
})(typeof window !== 'undefined' ? window : globalThis);

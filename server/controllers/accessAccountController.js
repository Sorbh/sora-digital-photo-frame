const bcrypt = require('bcryptjs');
const { getDataStore } = require('../store');
const { passClientError } = require('../utils/httpError');

// bcrypt cost for PINs: each sign-in compares against every account's hash, so keep it modest
const PIN_ROUNDS = 10;

class AccessAccountController {
    constructor() {
        // Rate limiting for PIN attempts
        this.pinSignIn = true; // createApp({ pinSignIn: false }) turns it off (hosted: frames pair instead)
        this.rateLimiter = new Map(); // Map<IP, {attempts: number, lockoutUntil: number, firstAttempt: number}>
        this.maxAttempts = 5; // Maximum failed attempts
        this.lockoutDuration = 15 * 60 * 1000; // 15 minutes in milliseconds
        this.attemptWindow = 5 * 60 * 1000; // 5 minutes window for attempts
    }

    async loadAccounts() {
        try {
            const accounts = await getDataStore().get('access-accounts', []);
            // Accounts saved before PINs were hashed are hashed the first time they're read
            return accounts.some(account => account.pin !== undefined) ? await this.hashStoredPins() : accounts;
        } catch (error) {
            return [];
        }
    }

    hashStoredPins() {
        return getDataStore().update('access-accounts', [], accounts => Promise.all(accounts.map(async (account) => {
            if (account.pin === undefined) return account;
            const { pin, ...rest } = account;
            return { ...rest, pinHash: await this.hashPin(pin) };
        })));
    }

    hashPin(pin) {
        return bcrypt.hash(String(pin), PIN_ROUNDS);
    }

    async pinMatches(account, pin) {
        if (account.pinHash) return bcrypt.compare(String(pin), account.pinHash);
        return account.pin !== undefined && String(account.pin) === String(pin);
    }

    // The account with this PIN, if any (optionally ignoring one account)
    async findByPin(accounts, pin, exceptId = null) {
        for (const account of accounts) {
            if (account.id !== exceptId && await this.pinMatches(account, pin)) return account;
        }
        return null;
    }

    // What the admin page gets: never the PIN or its hash
    publicAccount({ pin, pinHash, ...account }) {
        return { ...account, hasPin: Boolean(pin || pinHash) };
    }

    async saveAccounts(accounts) {
        await getDataStore().set('access-accounts', accounts);
    }

    // Rate limiting methods
    checkRateLimit(ip) {
        const now = Date.now();
        const record = this.rateLimiter.get(ip);
        
        if (!record) {
            return { allowed: true, attemptsRemaining: this.maxAttempts };
        }
        
        // Check if lockout period has expired
        if (record.lockoutUntil && now < record.lockoutUntil) {
            const remainingTime = Math.ceil((record.lockoutUntil - now) / 1000 / 60); // minutes
            return { 
                allowed: false, 
                locked: true, 
                remainingTime,
                message: `Too many failed attempts. Try again in ${remainingTime} minutes.`
            };
        }
        
        // Check if attempt window has expired (reset counter)
        if (record.firstAttempt && (now - record.firstAttempt) > this.attemptWindow) {
            this.rateLimiter.delete(ip);
            return { allowed: true, attemptsRemaining: this.maxAttempts };
        }
        
        // Check if max attempts reached
        if (record.attempts >= this.maxAttempts) {
            // Set lockout
            record.lockoutUntil = now + this.lockoutDuration;
            const remainingTime = Math.ceil(this.lockoutDuration / 1000 / 60);
            return {
                allowed: false,
                locked: true,
                remainingTime,
                message: `Too many failed attempts. Account locked for ${remainingTime} minutes.`
            };
        }
        
        return { 
            allowed: true, 
            attemptsRemaining: this.maxAttempts - record.attempts 
        };
    }
    
    recordFailedAttempt(ip) {
        const now = Date.now();
        const record = this.rateLimiter.get(ip);
        
        if (!record) {
            this.rateLimiter.set(ip, {
                attempts: 1,
                firstAttempt: now,
                lockoutUntil: null
            });
        } else {
            record.attempts += 1;
            if (!record.firstAttempt) {
                record.firstAttempt = now;
            }
        }
    }
    
    recordSuccessfulAttempt(ip) {
        // Clear rate limiting on successful authentication
        this.rateLimiter.delete(ip);
    }

    generateAccountId() {
        return 'acc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    // A new account with a PIN nobody has yet (used when a frame is paired by QR code)
    async addAccountWithRandomPin({ name, assignedFolders = [] }) {
        let account;
        await getDataStore().update('access-accounts', [], async accounts => {
            let pin;
            do {
                pin = String(require('crypto').randomInt(100000, 1000000));
            } while (await this.findByPin(accounts, pin));
            account = {
                id: this.generateAccountId(),
                name,
                pinHash: await this.hashPin(pin),
                assignedFolders,
                createdAt: new Date().toISOString(),
                lastAccessed: null
            };
            return [...accounts, account];
        });
        return account;
    }

    async getAllAccounts(req, res) {
        try {
            const accounts = await this.loadAccounts();
            res.json({ accounts: accounts.map(account => this.publicAccount(account)) });
        } catch (error) {
            if (passClientError(res, error)) return;
            console.error('Error fetching accounts:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch accounts'
            });
        }
    }

    async createAccount(req, res) {
        try {
            const { name, pin, assignedFolders = [] } = req.body;

            if (!name || !pin) {
                return res.status(400).json({
                    success: false,
                    error: 'Name and PIN are required'
                });
            }

            let duplicate = false;
            let newAccount;
            const pinHash = await this.hashPin(pin);
            await this.loadAccounts(); // hash any PINs still stored as-is first
            await getDataStore().update('access-accounts', [], async accounts => {
                duplicate = Boolean(await this.findByPin(accounts, pin));
                if (duplicate) return accounts;
                newAccount = {
                    id: this.generateAccountId(),
                    name,
                    pinHash,
                    assignedFolders,
                    createdAt: new Date().toISOString(),
                    lastAccessed: null
                };
                return [...accounts, newAccount];
            });
            if (duplicate) {
                return res.status(400).json({
                    success: false,
                    error: 'PIN already exists',
                    code: 'DUPLICATE_PIN'
                });
            }

            res.status(201).json({
                success: true,
                account: this.publicAccount(newAccount)
            });
        } catch (error) {
            if (passClientError(res, error)) return;
            console.error('Error creating account:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to create account'
            });
        }
    }

    async updateAccount(req, res) {
        try {
            const { id } = req.params;
            const { name, pin, assignedFolders = [] } = req.body;

            // PINs can't be shown, so a blank PIN keeps the current one
            if (!name) {
                return res.status(400).json({
                    success: false,
                    error: 'Name is required'
                });
            }

            let notFound = false;
            let duplicate = false;
            let updatedAccount;
            const pinHash = pin ? await this.hashPin(pin) : null;
            await this.loadAccounts();
            await getDataStore().update('access-accounts', [], async accounts => {
                const accountIndex = accounts.findIndex(account => account.id === id);
                if (accountIndex === -1) { notFound = true; return accounts; }
                duplicate = Boolean(pin && await this.findByPin(accounts, pin, id));
                if (duplicate) return accounts;
                updatedAccount = { ...accounts[accountIndex], name, assignedFolders };
                if (pinHash) { delete updatedAccount.pin; updatedAccount.pinHash = pinHash; }
                const next = [...accounts];
                next[accountIndex] = updatedAccount;
                return next;
            });
            if (notFound) {
                return res.status(404).json({
                    success: false,
                    error: 'Account not found',
                    code: 'ACCOUNT_NOT_FOUND'
                });
            }

            if (duplicate) {
                return res.status(400).json({
                    success: false,
                    error: 'PIN already exists',
                    code: 'DUPLICATE_PIN'
                });
            }

            res.json({
                success: true,
                account: this.publicAccount(updatedAccount)
            });
        } catch (error) {
            if (passClientError(res, error)) return;
            console.error('Error updating account:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to update account'
            });
        }
    }

    async deleteAccount(req, res) {
        try {
            const { id } = req.params;
            let notFound = false;
            await getDataStore().update('access-accounts', [], accounts => {
                const kept = accounts.filter(account => account.id !== id);
                notFound = kept.length === accounts.length;
                return kept;
            });
            if (notFound) {
                return res.status(404).json({
                    success: false,
                    error: 'Account not found',
                    code: 'ACCOUNT_NOT_FOUND'
                });
            }

            // Frames paired to this account stop working with it
            await require('../services/pairingService').removeDevices(device => device.accountId === id);

            res.json({
                success: true,
                message: 'Account deleted successfully'
            });
        } catch (error) {
            if (passClientError(res, error)) return;
            console.error('Error deleting account:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to delete account'
            });
        }
    }

    async authenticateWithPin(req, res) {
        if (!this.pinSignIn) {
            return res.status(404).json({ success: false, error: 'PIN sign-in is turned off', code: 'PIN_DISABLED' });
        }
        try {
            const { pin } = req.body;
            const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;

            // Check rate limiting
            const rateLimitCheck = this.checkRateLimit(clientIP);
            if (!rateLimitCheck.allowed) {
                console.log(`🚫 Rate limit exceeded for IP: ${clientIP}`);
                return res.status(429).json({
                    success: false,
                    error: rateLimitCheck.message,
                    code: 'RATE_LIMITED',
                    remainingTime: rateLimitCheck.remainingTime
                });
            }

            if (!pin) {
                return res.status(400).json({
                    success: false,
                    error: 'PIN is required'
                });
            }

            const accounts = await this.loadAccounts();
            const account = await this.findByPin(accounts, pin);

            if (!account) {
                // Record failed attempt
                this.recordFailedAttempt(clientIP);
                const newRateLimitCheck = this.checkRateLimit(clientIP);
                
                console.log(`❌ Failed PIN attempt from IP: ${clientIP}, attempts remaining: ${newRateLimitCheck.attemptsRemaining || 0}`);
                
                return res.status(401).json({
                    success: false,
                    error: 'Invalid PIN',
                    code: 'INVALID_PIN',
                    attemptsRemaining: newRateLimitCheck.attemptsRemaining || 0
                });
            }

            // Record successful attempt (clears rate limiting)
            this.recordSuccessfulAttempt(clientIP);
            console.log(`✅ Successful PIN authentication from IP: ${clientIP} for account: ${account.name}`);

            // Update last accessed time
            await getDataStore().update('access-accounts', [], current => current.map(item =>
                item.id === account.id ? { ...item, lastAccessed: new Date().toISOString() } : item));

            // Store account info in session
            req.session.accessAccount = {
                id: account.id,
                name: account.name,
                assignedFolders: account.assignedFolders
            };

            res.json({
                success: true,
                account: {
                    id: account.id,
                    name: account.name,
                    assignedFolders: account.assignedFolders
                }
            });
        } catch (error) {
            if (passClientError(res, error)) return;
            console.error('Error authenticating with PIN:', error);
            res.status(500).json({
                success: false,
                error: 'Authentication failed'
            });
        }
    }

    async getSession(req, res) {
        try {
            if (req.session.accessAccount) {
                res.json({
                    authenticated: true,
                    account: req.session.accessAccount,
                    pinSignIn: this.pinSignIn
                });
            } else {
                res.json({
                    authenticated: false,
                    pinSignIn: this.pinSignIn
                });
            }
        } catch (error) {
            if (passClientError(res, error)) return;
            console.error('Error checking session:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to check session'
            });
        }
    }

    async clearSession(req, res) {
        try {
            // A frame signing out in the admin's browser keeps the admin signed in
            if (req.session.authenticated) {
                delete req.session.accessAccount;
                delete req.session.tenantId;
                return res.json({ success: true, message: 'Session cleared' });
            }

            req.session.destroy((err) => {
                if (err) {
                    console.error('Error destroying session:', err);
                    return res.status(500).json({
                        success: false,
                        error: 'Failed to clear session'
                    });
                }
                
                res.clearCookie('photoframe.sid'); // Custom session cookie name
                res.json({
                    success: true,
                    message: 'Session cleared'
                });
            });
        } catch (error) {
            if (passClientError(res, error)) return;
            console.error('Error clearing session:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to clear session'
            });
        }
    }
}

module.exports = new AccessAccountController();

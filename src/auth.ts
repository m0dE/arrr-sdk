// SDK Auth Module for OAuth-based authentication

export interface AuthUser {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  provider: 'discord' | 'google' | 'twitter' | 'guest';
}

export interface AuthError {
  code: string;
  message: string;
}

export type AuthProvider = 'discord' | 'google' | 'twitter' | 'guest';

export interface LoginOptions {
  provider?: AuthProvider;
}

export interface AuthInitOptions {
  appId: string;
  centralServiceUrl?: string;
  debug?: boolean;
}

export interface AuthUIOptions {
  /** CSS selector for the container to mount into. If not provided, creates a modal overlay. */
  container?: string;
  /** Whether to show the guest login option */
  showGuest?: boolean;
  /** Whether to automatically close the UI on successful login */
  autoClose?: boolean;
  /** Callbacks */
  onLogin?: (user: AuthUser) => void;
  onGuest?: (guestName: string) => void;
}

type AuthSuccessCallback = (authCode: string) => void;
type AuthErrorCallback = (error: AuthError) => void;
type AuthStateChangeCallback = (user: AuthUser | null) => void;

const TOKEN_KEY = 'arrr_auth_token';
const RETURN_URL_KEY = 'arrr_auth_return_url';

class AuthModule {
  private appId: string | null = null;
  private centralServiceUrl: string = 'https://nodes.arrr.fun';
  private debug: boolean = false;
  private initialized: boolean = false;

  private successCallbacks: AuthSuccessCallback[] = [];
  private errorCallbacks: AuthErrorCallback[] = [];
  private stateChangeCallbacks: AuthStateChangeCallback[] = [];

  private currentUser: AuthUser | null = null;
  private pendingAuthCode: string | null = null;
  private pendingAuthError: AuthError | null = null;

  // UI state
  private uiContainer: HTMLElement | null = null;
  private uiOptions: AuthUIOptions | null = null;
  private isModal: boolean = false;
  private isLoading: boolean = false;
  private loadingTimeout: any = null;

  /**
   * Initialize the auth module
   */
  init(options: AuthInitOptions): void {
    this.appId = options.appId;
    this.debug = options.debug || false;

    // Determine central service URL
    if (options.centralServiceUrl) {
      this.centralServiceUrl = options.centralServiceUrl;
    }

    this.initialized = true;
    this.log('Auth module initialized', { appId: this.appId, centralServiceUrl: this.centralServiceUrl });

    // Sequence these properly: first handle callback (if any), then check session
    this.processInitialAuth();
  }

  private async processInitialAuth(): Promise<void> {
    await this.handleAuthCallback();
    await this.checkExistingSession();
  }

  /**
   * High-level helper: Initialize and ensure the user is authenticated.
   * Shows the login UI automatically if no session exists.
   * Returns a function to unsubscribe from the listener.
   */
  onReady(options: AuthInitOptions & AuthUIOptions, callback: (user: AuthUser) => void): () => void {
    if (!this.initialized) {
      this.init(options);
    }

    const stop = this.onAuthStateChange((user) => {
      if (user) {
        this.hideUI(); // Ensure UI is hidden when user is ready
        callback(user);
        stop();
      } else {
        this.showUI(options);
      }
    });

    return stop;
  }

  /**
   * Show the built-in Auth UI
   */
  showUI(options: AuthUIOptions = {}): void {
    this.ensureInitialized();
    this.uiOptions = {
      showGuest: true,
      autoClose: true,
      ...options
    };

    this.ensureStyles();

    // Create or find container
    if (this.uiOptions.container) {
      const el = document.querySelector(this.uiOptions.container);
      if (!el) throw new Error(`Container ${this.uiOptions.container} not found`);
      this.uiContainer = el as HTMLElement;
      this.isModal = false;
    } else {
      // Create modal overlay
      if (this.uiContainer) {
        // If already showing the same overlay, don't recreate it
        if (this.uiContainer.classList.contains('arrr-auth-overlay')) return;
        this.hideUI();
      }
      this.uiContainer = document.createElement('div');
      this.uiContainer.className = 'arrr-auth-overlay';
      document.body.appendChild(this.uiContainer);
      this.isModal = true;
    }

    this.renderUI();

    // If we're already loading (e.g. checking session), show spinner
    if (this.isLoading) {
      this.showLoading();
    }

    // Listen for auth changes to auto-close if needed
    const cleanup = this.onAuthStateChange((user) => {
      if (user && this.uiOptions?.autoClose) {
        const onLogin = this.uiOptions.onLogin;
        this.hideUI();
        if (onLogin) onLogin(user);
        cleanup();
      }
    });
  }

  /**
   * Hide the Auth UI
   */
  hideUI(): void {
    if (this.uiContainer) {
      if (this.isModal && this.uiContainer.parentNode) {
        this.uiContainer.parentNode.removeChild(this.uiContainer);
      } else {
        this.uiContainer.innerHTML = '';
      }
      this.uiContainer = null;
      this.uiOptions = null;
    }
  }

  private renderUI(): void {
    if (!this.uiContainer) return;

    this.uiContainer.innerHTML = `
        <div class="arrr-auth-card">
            <div class="arrr-auth-header">
                <h2>Sign In</h2>
                <p>Play to save your progress</p>
            </div>
            
            <div class="arrr-auth-buttons">
                <button class="arrr-btn arrr-btn-discord" data-provider="discord">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 4.164 4.164 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.118.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                    Continue with Discord
                </button>
                
                <button class="arrr-btn arrr-btn-google" data-provider="google">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81z"/></svg>
                    Continue with Google
                </button>
                
                ${this.uiOptions?.showGuest ? `
        <div class="arrr-auth-divider" >
          <span>or </span>
                </div>
                
                <button class="arrr-btn arrr-btn-guest" data-provider="guest">
                    Play as Guest
                </button>
                ` : ''}
            </div>
        </div>
    `;

    // Attach listeners
    this.uiContainer.querySelectorAll('[data-provider]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const provider = (e.currentTarget as HTMLElement).dataset.provider;
        if (provider === 'guest') {
          this.handleGuestLogin();
        } else {
          this.login({ provider: provider as AuthProvider });
        }
      });
    });
  }

  private showLoading(): void {
    if (!this.uiContainer) return;
    const card = this.uiContainer.querySelector('.arrr-auth-card');
    if (card) {
      card.innerHTML = `
        <div class="arrr-auth-header">
            <h2>Please wait</h2>
            <p>Authenticating your session...</p>
        </div>
        <div class="arrr-spinner-container">
            <div class="arrr-spinner"></div>
        </div>
      `;
    }

    // Safety timeout: if we're still loading after 10s, something's wrong
    if (this.loadingTimeout) clearTimeout(this.loadingTimeout);
    this.loadingTimeout = setTimeout(() => {
      if (this.isLoading) {
        this.log('Auth loading timed out');
        this.isLoading = false;
        this.renderUI(); // Back to buttons
      }
    }, 10000);
  }

  private handleGuestLogin(): void {
    const guestName = `Guest_${Math.floor(Math.random() * 9999)}`;
    const guestUser: AuthUser = {
      id: 'guest_' + Math.random().toString(36).slice(2, 11),
      email: null,
      displayName: guestName,
      avatarUrl: null,
      provider: 'guest'
    };

    const autoClose = this.uiOptions?.autoClose;
    const onGuest = this.uiOptions?.onGuest;

    if (onGuest) {
      onGuest(guestName);
    }

    // Notify listeners so onReady/onAuthStateChange fire
    this.notifyStateChange(guestUser);

    if (autoClose) {
      this.hideUI();
    }
  }

  private ensureStyles(): void {
    if (typeof document === 'undefined' || document.getElementById('arrr-auth-styles')) return;

    const css = `
        .arrr-auth-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(15, 15, 30, 0.9);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            font-family: system-ui, -apple-system, sans-serif;
            backdrop-filter: blur(8px);
        }

        .arrr-auth-card {
            background: #1a1a2e;
            border: 1px solid #252545;
            border-radius: 20px;
            padding: 40px;
            width: 100%;
            max-width: 400px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            animation: arrrFadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes arrrFadeIn {
            from { opacity: 0; transform: scale(0.95) translateY(10px); }
            to { opacity: 1; transform: scale(1) translateY(0); }
        }

        .arrr-auth-header {
            text-align: center;
            margin-bottom: 32px;
        }

        .arrr-auth-header h2 {
            color: #fff;
            margin: 0 0 10px 0;
            font-size: 28px;
            font-weight: 700;
            letter-spacing: -0.5px;
        }

        .arrr-auth-header p {
            color: #8888aa;
            margin: 0;
            font-size: 16px;
        }

        .arrr-auth-buttons {
            display: flex;
            flex-direction: column;
            gap: 14px;
        }

        .arrr-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            width: 100%;
            padding: 14px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }

        .arrr-btn:hover {
            transform: translateY(-2px);
            filter: brightness(1.1);
        }

        .arrr-btn:active {
            transform: translateY(0);
        }

        .arrr-btn-discord {
            background: #5865F2;
            color: #fff;
        }

        .arrr-btn-google {
            background: #fff;
            color: #1a1a2e;
        }

        .arrr-btn-guest {
            background: #252545;
            color: #8888aa;
            border: 1px solid #333366;
        }
        
        .arrr-btn-guest:hover {
            background: #333366;
            color: #fff;
        }

        .arrr-auth-divider {
            display: flex;
            align-items: center;
            margin: 10px 0;
            color: #444466;
            font-size: 14px;
        }

        .arrr-auth-divider::before,
        .arrr-auth-divider::after {
            content: '';
            flex: 1;
            height: 1px;
            background: #252545;
        }

        .arrr-auth-divider span {
            padding: 0 15px;
            text-transform: uppercase;
            font-weight: 600;
            font-size: 12px;
        }

        .arrr-spinner-container {
            display: flex;
            justify-content: center;
            padding: 20px 0;
        }

        .arrr-spinner {
            width: 40px;
            height: 40px;
            border: 3px solid rgba(76, 201, 240, 0.1);
            border-radius: 50%;
            border-top-color: #4cc9f0;
            animation: arrr-spin 1s ease-in-out infinite;
        }

        @keyframes arrr-spin {
            to { transform: rotate(360deg); }
        }
    `;

    const style = document.createElement('style');
    style.id = 'arrr-auth-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /**
   * Start the login flow
   */
  login(options?: LoginOptions): void {
    this.ensureInitialized();

    const provider = options?.provider;
    const returnUrl = typeof window !== 'undefined' ? window.location.href : '/';

    // Save return URL for after OAuth
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(RETURN_URL_KEY, returnUrl);
    }

    // Build auth URL
    const params = new URLSearchParams({
      appId: this.appId!,
      returnUrl: returnUrl
    });

    let authUrl: string;
    if (provider) {
      // Direct to specific provider
      authUrl = `${this.centralServiceUrl}/auth/${provider}?${params}`;
    } else {
      // Show provider selection page
      authUrl = `${this.centralServiceUrl}/auth/select?${params}`;
    }

    this.log('Starting login flow', { provider, authUrl });

    // Redirect to auth URL
    if (typeof window !== 'undefined') {
      window.location.href = authUrl;
    }
  }

  /**
   * Logout the current user
   */
  async logout(): Promise<void> {
    this.ensureInitialized();

    const token = this.getStoredToken();
    if (token) {
      // Call logout endpoint (best-effort)
      try {
        await fetch(`${this.centralServiceUrl}/auth/logout`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
      } catch (err) {
        this.log('Logout API call failed (continuing anyway)', err);
      }
    }

    // Clear stored token
    this.clearStoredToken();
    this.currentUser = null;

    // Notify listeners
    this.notifyStateChange(null);

    this.log('User logged out');
  }

  /**
   * Get the current user
   */
  async getUser(): Promise<AuthUser | null> {
    this.ensureInitialized();

    // Return cached user if available
    if (this.currentUser) {
      return this.currentUser;
    }

    const token = this.getStoredToken();
    if (!token) {
      return null;
    }

    try {
      const response = await fetch(`${this.centralServiceUrl}/auth/whoami`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        // Token invalid/expired
        this.clearStoredToken();
        return null;
      }

      const data = await response.json();
      this.currentUser = data.user;
      return this.currentUser;
    } catch (err) {
      this.log('Failed to get user', err);
      return null;
    }
  }

  /**
   * Delete the user's account
   */
  async deleteAccount(): Promise<void> {
    this.ensureInitialized();

    const token = this.getStoredToken();
    if (!token) {
      throw new Error('Not logged in');
    }

    const response = await fetch(`${this.centralServiceUrl}/auth/account`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to delete account' }));
      throw new Error(error.error);
    }

    // Clear local state
    this.clearStoredToken();
    this.currentUser = null;
    this.notifyStateChange(null);

    this.log('Account deleted');
  }

  /**
   * Register callback for successful auth
   */
  onSuccess(callback: AuthSuccessCallback): () => void {
    this.successCallbacks.push(callback);

    // If there's a pending auth code, fire callback immediately
    if (this.pendingAuthCode) {
      const code = this.pendingAuthCode;
      this.pendingAuthCode = null; // Clear to prevent duplicate calls
      callback(code);
    }

    return () => {
      const idx = this.successCallbacks.indexOf(callback);
      if (idx !== -1) this.successCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register callback for auth errors
   */
  onError(callback: AuthErrorCallback): () => void {
    this.errorCallbacks.push(callback);

    // If there's a pending auth error, fire callback immediately
    if (this.pendingAuthError) {
      const error = this.pendingAuthError;
      this.pendingAuthError = null; // Clear to prevent duplicate calls
      callback(error);
    }

    return () => {
      const idx = this.errorCallbacks.indexOf(callback);
      if (idx !== -1) this.errorCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register callback for auth state changes
   */
  onAuthStateChange(callback: AuthStateChangeCallback): () => void {
    this.stateChangeCallbacks.push(callback);
    // Immediately call with current state
    callback(this.currentUser);
    return () => {
      const idx = this.stateChangeCallbacks.indexOf(callback);
      if (idx !== -1) this.stateChangeCallbacks.splice(idx, 1);
    };
  }

  /**
   * Get the stored session token (for backend calls)
   */
  getToken(): string | null {
    return this.getStoredToken();
  }

  /**
   * Set a session token (received from backend after code exchange)
   */
  setToken(token: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TOKEN_KEY, token);
    }
    // Refresh user data
    this.checkExistingSession();
  }

  // Private methods

  private ensureInitialized(): void {
    if (!this.initialized || !this.appId) {
      throw new Error('Auth module not initialized. Call arrrNetwork.auth.init() first.');
    }
  }

  private async handleAuthCallback(): Promise<void> {
    if (typeof window === 'undefined') return;

    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (code || error) {
      this.isLoading = true;
      if (this.uiContainer) this.showLoading();
    }

    try {
      if (error) {
        // Auth error from OAuth flow
        this.log('Auth error received', { error, errorDescription });

        // Clean up URL
        url.searchParams.delete('error');
        url.searchParams.delete('error_description');
        window.history.replaceState({}, '', url.toString());

        // Store error for callbacks registered later
        this.pendingAuthError = {
          code: error,
          message: errorDescription || error
        };

        // Notify any already-registered callbacks
        this.errorCallbacks.forEach(cb => cb(this.pendingAuthError!));
        return;
      }

      if (code) {
        this.log('Auth code received', { code: code.substring(0, 20) + '...' });

        // Clean up URL
        url.searchParams.delete('code');
        window.history.replaceState({}, '', url.toString());

        // Exchange auth code for session token and store it
        const response = await fetch(`${this.centralServiceUrl}/auth/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });

        if (response.ok) {
          const { token } = await response.json();
          if (token) {
            // Store the session token
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem(TOKEN_KEY, token);
            }
            this.log('Session token stored');

            // Success! Store and notify
            this.pendingAuthCode = code;
            this.successCallbacks.forEach(cb => cb(code));
          }
        } else {
          this.log('Failed to exchange auth code');
        }
      }
    } catch (err) {
      this.log('Error in handleAuthCallback:', err);
    } finally {
      this.isLoading = false;
    }
  }

  private async checkExistingSession(): Promise<void> {
    const hasToken = !!this.getStoredToken();
    if (hasToken && !this.currentUser) {
      this.isLoading = true;
      if (this.uiContainer) this.showLoading();
    }

    const user = await this.getUser();
    this.isLoading = false;
    this.notifyStateChange(user);
  }

  private notifyStateChange(user: AuthUser | null): void {
    this.currentUser = user;
    this.stateChangeCallbacks.forEach(cb => cb(user));
  }

  private getStoredToken(): string | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(TOKEN_KEY);
  }

  private clearStoredToken(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(RETURN_URL_KEY);
    }
  }

  private log(...args: any[]): void {
    if (this.debug) {
      console.log('[arrr-auth]', ...args);
    }
  }
}

// Singleton instance
export const auth = new AuthModule();

// Browser global
if (typeof window !== 'undefined') {
  (window as any).arrrAuth = auth;
}

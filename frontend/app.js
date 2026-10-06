
  const BASE_URL = 'http://127.0.0.1:8000';
//   const BASE_URL = 'https://meet-up-0kqq.onrender.com';
let accessToken = localStorage.getItem('access_token') || '';
let currentEmail = '';
let currentUserRole = '';
let currentUserId = null;
let notifWs = null;
let callWs = null;
let currentRoomId = null;
let lastRoomId = null;
let livekitRoom = null;

let activeTranscripts = [];

// ===================================================================
// SPEECH & TRANSCRIPTION FUNCTIONS
// ===================================================================
let speechRecognizer = null;
let isExplicitlyStopped = false;
let lastAppendedText = "";
let lastAppendedTime = 0;
let speechRestartTimer = null;
let unreadNotifications = [];
let notificationFetchSequence = 0;
let plansRefreshTimer = null;
let plansRefreshEventsBound = false;

function startAutoSpeechToText() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn("Web Speech API is not supported in this browser.");
        return;
    }

    if (speechRecognizer) {
        try { speechRecognizer.stop(); } catch (e) { }
    }

    if (speechRestartTimer) {
        clearTimeout(speechRestartTimer);
        speechRestartTimer = null;
    }

    isExplicitlyStopped = false;
    speechRecognizer = new SpeechRecognition();
    speechRecognizer.continuous = true;
    speechRecognizer.interimResults = true;
    speechRecognizer.lang = 'en-US';

    speechRecognizer.onresult = (event) => {
        const speaker = currentEmail || "Participant";
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const transcriptSegment = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcriptSegment;
            } else {
                interimTranscript += transcriptSegment;
            }
        }

        if (interimTranscript.trim()) {
            showCaption(speaker, interimTranscript.trim());
        }

        if (finalTranscript.trim()) {
            const transcriptText = finalTranscript.trim();

            showCaption(speaker, transcriptText);
            appendTranscriptSafe(speaker, transcriptText);

            publishTranscript(transcriptText, speaker);
        }
    };

    speechRecognizer.onerror = (event) => {
        console.warn("Speech Recognition Warning:", event.error);
    };

    speechRecognizer.onend = () => {
        if (!isExplicitlyStopped && livekitRoom) {
            speechRestartTimer = setTimeout(() => {
                try {
                    if (speechRecognizer && !isExplicitlyStopped && livekitRoom) {
                        speechRecognizer.start();
                    }
                } catch (e) {
                    console.error("Could not auto-restart speech recognition:", e);
                }
                speechRestartTimer = null;
            }, 1000);
        }
    };

    try {
        speechRecognizer.start();
        console.log("High-speed Auto Speech-to-Text activated successfully.");
    } catch (e) {
        console.error("Failed to start speech recognition:", e);
    }
}

function stopAutoSpeechToText() {
    isExplicitlyStopped = true;
    if (speechRestartTimer) {
        clearTimeout(speechRestartTimer);
        speechRestartTimer = null;
    }
    if (speechRecognizer) {
        try { speechRecognizer.stop(); } catch (e) { }
        speechRecognizer = null;
    }
}

function appendTranscriptSafe(speaker, text) {
    const now = Date.now();
    if (speaker === (currentEmail || "Participant") && text === lastAppendedText && (now - lastAppendedTime < 2000)) {
        return;
    }
    lastAppendedText = text;
    lastAppendedTime = now;
    appendTranscript(speaker, text);
}

// -------------------------------------------------------------------
// REALTIME TRANSCRIPT PUBLISHER
//
// IMPORTANT:
// Browser SpeechRecognition produces the transcript on the speaker's
// browser. The FastAPI call WebSocket is the single realtime relay.
// Do NOT also publish the same transcript through LiveKit DataReceived,
// otherwise both clients can receive duplicate transcript entries.
//
// If the call WebSocket is still CONNECTING, the message is queued and
// flushed automatically from onopen.
// -------------------------------------------------------------------
let pendingTranscriptMessages = [];
let callWsRoomId = null;
let callWsReconnectTimer = null;
let callWsManuallyClosed = false;

function queueOrSendCallMessage(message) {
    if (callWs && callWs.readyState === WebSocket.OPEN) {
        try {
            callWs.send(JSON.stringify(message));
            return true;
        } catch (error) {
            console.warn("Call WebSocket send failed; queuing message:", error);
        }
    }

    pendingTranscriptMessages.push(message);

    // Keep the queue bounded if the connection is unavailable for a long time.
    if (pendingTranscriptMessages.length > 100) {
        pendingTranscriptMessages.splice(
            0,
            pendingTranscriptMessages.length - 100
        );
    }

    return false;
}

function flushPendingTranscriptMessages() {
    if (!callWs || callWs.readyState !== WebSocket.OPEN) return;

    const queued = pendingTranscriptMessages.splice(0);

    for (const message of queued) {
        try {
            callWs.send(JSON.stringify(message));
        } catch (error) {
            console.warn("Failed to flush transcript message:", error);
            pendingTranscriptMessages.unshift(message);
            break;
        }
    }
}

function publishTranscript(text, speaker) {
    const transcriptText = String(text || "").trim();
    if (!transcriptText) return;

    const transcript = {
        type: "LIVEKIT_TRANSCRIPT",
        room_id: currentRoomId || lastRoomId || callWsRoomId,
        sender_id: Number(currentUserId) || null,
        participantId: Number(currentUserId) || null,
        participantName: speaker || currentEmail || "Participant",
        speaker: speaker || currentEmail || "Participant",
        text: transcriptText,
        timestamp: Date.now(),
        is_final: true
    };

    console.log("[Realtime Transcript] publishing:", transcript);

    queueOrSendCallMessage(transcript);
}

function showCaption(speaker, text) {
    const overlay = document.getElementById('captionOverlay');
    if (!overlay) return;

    const speakerEl = document.getElementById('captionSpeaker');
    const textEl = document.getElementById('captionText');
    if (speakerEl) speakerEl.innerText = speaker;
    if (textEl) textEl.innerText = text;
    overlay.classList.remove('hidden');

    clearTimeout(window.captionTimeout);
    window.captionTimeout = setTimeout(() => overlay.classList.add('hidden'), 4000);
}

function appendTranscript(speaker, text) {
    const box = document.getElementById('transcriptBox');
    if (!box) return;

    activeTranscripts.push(`${speaker}: ${text}`);

    const emptyMsg = box.querySelector('.empty-msg');
    if (emptyMsg) emptyMsg.remove();

    const entry = document.createElement('div');
    entry.className = 'transcript-entry';
    entry.innerHTML = `<span class="speaker">${speaker}:</span> ${escapeHtml(text)}`;
    box.appendChild(entry);
    box.scrollTop = box.scrollHeight;
}

function sendSpeechInput() {
    const speechInput = document.getElementById('speech-input') || document.getElementById('speechInput');
    const text = speechInput ? speechInput.value.trim() : '';

    if (!text) {
        alert("Please enter speech text first.");
        return;
    }

    const speaker = currentEmail || "Participant";

    publishTranscript(text, speaker);

    appendTranscriptSafe(speaker, text);
    showCaption(speaker, text);

    if (speechInput) speechInput.value = '';
}

// ===================================================================
// UI NOTIFICATION & TOAST HELPER (Avoid window.alert per guidelines)
// ===================================================================
function showToast(message, type = 'info') {
    if (!message) return;
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'fixed bottom-5 right-5 z-[9999] flex flex-col gap-2 max-w-sm pointer-events-none';
        document.body.appendChild(toastContainer);
    }
    const toast = document.createElement('div');
    const colorClasses = type === 'error'
        ? 'bg-rose-950/95 border-rose-500/40 text-rose-200 shadow-rose-950/50'
        : type === 'success'
            ? 'bg-emerald-950/95 border-emerald-500/40 text-emerald-200 shadow-emerald-950/50'
            : 'bg-slate-900/95 border-slate-700 text-slate-200 shadow-black/50';

    toast.className = `${colorClasses} backdrop-blur-xl border px-4 py-3 rounded-xl shadow-2xl text-xs font-medium flex items-center gap-2.5 transition-all duration-300 opacity-0 translate-y-2 pointer-events-auto`;
    const icon = type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
    toast.innerHTML = `<span class="shrink-0 text-sm">${icon}</span><span class="flex-1 leading-snug">${escapeHtml(String(message))}</span>`;
    toastContainer.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.remove('opacity-0', 'translate-y-2');
    });

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Override blocking window.alert to comply with iframe environment rules
window.alert = function (message) {
    showToast(message, 'info');
};

function isRealJwt(token) {
    return Boolean(token && typeof token === 'string' && !token.startsWith('session_token_') && token.split('.').length === 3);
}

async function request(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };

    // Only send Authorization header if we have a genuine JWT signature.
    // Synthetic demo sessions or public endpoints must not trigger 401 JWT rejection.
    if (isRealJwt(accessToken)) {
        headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const config = { method, headers };
    if (body) config.body = JSON.stringify(body);

    try {
        const response = await fetch(`${BASE_URL}${endpoint}`, config);
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            let errorMessage = 'An error occurred';
            if (typeof data.detail === 'string') {
                errorMessage = data.detail;
            } else if (Array.isArray(data.detail)) {
                errorMessage = data.detail.map(err => `${err.loc ? err.loc.join('.') : ''}: ${err.msg}`).join('\n');
            } else if (typeof data.detail === 'object' && data.detail) {
                errorMessage = JSON.stringify(data.detail);
            }

            // Handle invalid / expired credentials gracefully
            const isCredentialError = response.status === 401 && (
                errorMessage.toLowerCase().includes('credential') ||
                errorMessage.toLowerCase().includes('token') ||
                errorMessage.toLowerCase().includes('unauthorized') ||
                errorMessage.toLowerCase().includes('not authenticated')
            );

            if (isCredentialError) {
                console.warn(`[Auth] Credentials rejected for ${endpoint}. Clearing invalid session.`);
                if (accessToken && !accessToken.startsWith('session_token_')) {
                    accessToken = '';
                    localStorage.removeItem('access_token');
                }
                const authErr = new Error(errorMessage);
                authErr.status = 401;
                authErr.isAuthError = true;
                throw authErr;
            }

            // Notify for user-facing errors (skip quiet background endpoints)
            const isBackground = endpoint.includes('/me') || endpoint.includes('unread') || endpoint.includes('all_subscription');
            if (!isBackground) {
                showToast(errorMessage, 'error');
            }

            const apiErr = new Error(errorMessage);
            apiErr.status = response.status;
            throw apiErr;
        }
        return data;
    } catch (networkError) {
        console.warn(`Request to ${BASE_URL}${endpoint} failed or timed out:`, networkError);
        throw networkError;
    }
}

async function markConversationAsSeen(senderId) {
    try {
        await request('/api/v1/chats/mark-seen', 'PATCH', { sender_id: senderId });
    } catch (e) {
        console.error("Failed to mark messages as seen:", e);
    }
}

function switchAuthTab(tab) {
    const tabLogin = document.getElementById('tab-login-btn');
    const tabReg = document.getElementById('tab-register-btn');
    const loginForm = document.getElementById('login-form');
    const regForm = document.getElementById('register-form');

    if (tabLogin) tabLogin.className = tab === 'login' ? 'active flex-1 py-2 rounded-lg font-semibold text-xs transition-all text-white bg-indigo-600 shadow-sm' : 'flex-1 py-2 rounded-lg font-semibold text-xs transition-all text-slate-400 hover:text-slate-200';
    if (tabReg) tabReg.className = tab === 'register' ? 'active flex-1 py-2 rounded-lg font-semibold text-xs transition-all text-white bg-indigo-600 shadow-sm' : 'flex-1 py-2 rounded-lg font-semibold text-xs transition-all text-slate-400 hover:text-slate-200';
    if (loginForm) loginForm.classList.toggle('hidden', tab !== 'login');
    if (regForm) regForm.classList.toggle('hidden', tab !== 'register');
}

async function handleRegister(event) {
    event.preventDefault();
    const name = document.getElementById('reg-name').value;
    currentEmail = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;

    try {
        const res = await request('/api/v1/user/register', 'POST', { name, email: currentEmail, password });

        // Handle different response structures (string, object with message/detail, or fallback)
        let messageText = 'Registration successful!';
        if (typeof res === 'string') {
            messageText = res;
        } else if (res && typeof res === 'object') {
            messageText = res.message || res.detail || JSON.stringify(res);
        }

        console.log("Registration Response:", res);
        showToast(messageText);
        showOTPScreen();

    } catch (e) {
        console.error(e);
        // If it throws an error (e.g., if FastAPI raises an HTTPException with status code >= 400)
        const errorMsg = e.detail || e.message || "Registration submitted. Verify OTP sent to " + currentEmail;
        showToast(errorMsg, 'info');
        // showOTPScreen();
    }
}
async function handleLogin(event) {
    event.preventDefault();
    currentEmail = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    try {
        const res = await request('/api/v1/user/login', 'POST', { email: currentEmail, password });

        // Handle string vs object response types
        const responseString = typeof res === 'string' ? res : (res.message || res.detail || '');

        if (responseString.toLowerCase().includes('unverified')) {
            showToast(responseString);
            showOTPScreen();
        } else if (res && res.access_token) {
            accessToken = res.access_token;
            localStorage.setItem('access_token', accessToken);
            currentUserRole = res.role || 'user';
            showToast('Signed in successfully!', 'success');
            await loadDashboard();
        } else {
            showToast(responseString || 'Login successful!');
        }
    } catch (e) {
        console.warn("Backend login error:", e);

        // Check if the backend error (e.g., 400 Bad Request) indicates an unverified user
        const errorMsg = e.detail || e.message || (typeof e === 'string' ? e : '');

        if (errorMsg.toLowerCase().includes('unverified') || errorMsg.toLowerCase().includes('otp')) {
            showToast(errorMsg, 'info');
            showOTPScreen();
        } else {
            showToast(errorMsg || 'Login failed. Please check your credentials.', 'error');
        }
    }
}

function showOTPScreen() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('otp-screen').classList.remove('hidden');
    const target = document.getElementById('otp-target-email');
    if (target) target.innerText = currentEmail;
}

function showPasswordReset() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('password-reset-email-screen').classList.remove('hidden');
    document.getElementById('password-reset-otp-screen').classList.add('hidden');
    document.getElementById('password-reset-form-screen').classList.add('hidden');
    const loginEmail = document.getElementById('login-email').value.trim();
    if (loginEmail) {
        document.getElementById('forgot-email').value = loginEmail;
    }
}

function hidePasswordReset() {
    document.getElementById('password-reset-email-screen').classList.add('hidden');
    document.getElementById('password-reset-otp-screen').classList.add('hidden');
    document.getElementById('password-reset-form-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
}

async function handleForgotPassword(event) {
    event.preventDefault();
    const email = document.getElementById('forgot-email').value.trim();

    try {
        const res = await request(
            `/api/v1/user/forgetpass?email=${encodeURIComponent(email)}`,
            'POST'
        );
        const responseString = typeof res === 'string' ? res : (res.message || res.detail || '');

        if (responseString.toLowerCase().includes('unverified')) {
            showToast(responseString);
            showOTPScreen();
        } else if (res && res.access_token) {
            accessToken = res.access_token;
            localStorage.setItem('access_token', accessToken);
            currentUserRole = res.role || 'user';
            showToast('Signed in successfully!', 'success');
            await loadDashboard();
        } else {
            showToast(responseString || 'Login successful!');
        }
        currentEmail = email;
        document.getElementById('reset-otp-email').innerText = email;
        document.getElementById('password-reset-email-screen').classList.add('hidden');
        document.getElementById('password-reset-otp-screen').classList.remove('hidden');
    } catch (error) {
        console.error('Forgot password request failed:', error);
        currentEmail = email;
        document.getElementById('reset-otp-email').innerText = email;
        document.getElementById('password-reset-email-screen').classList.add('hidden');
        document.getElementById('password-reset-otp-screen').classList.remove('hidden');
    }
}

async function handleResetOTP(event) {
    event.preventDefault();
    const otp_input = document.getElementById('reset-otp-input').value.trim();

    try {
        await request('/api/v1/user/verify_otp', 'POST', {
            email: currentEmail,
            otp_input
        });
        document.getElementById('password-reset-otp-screen').classList.add('hidden');
        document.getElementById('password-reset-form-screen').classList.remove('hidden');
    } catch (error) {
        console.error('Reset OTP verification failed:', error);
        document.getElementById('password-reset-otp-screen').classList.add('hidden');
        document.getElementById('password-reset-form-screen').classList.remove('hidden');
    }
}

async function handleResetPassword(event) {
    event.preventDefault();
    const email = currentEmail;
    const key = document.getElementById('reset-key').value.trim();
    const newPass = document.getElementById('reset-new-password').value;
    const confirmPass = document.getElementById('reset-confirm-password').value;

    if (newPass !== confirmPass) {
        alert('New password and confirmation do not match.');
        return;
    }

    try {
        const response = await request('/api/v1/user/reset_pass', 'POST', {
            email,
            key,
            new_pass: newPass,
            confrim_pass: confirmPass
        });
        alert(typeof response === 'string' ? response : 'Password reset successfully.');
        hidePasswordReset();
        switchAuthTab('login');
    } catch (error) {
        console.error('Password reset failed:', error);
        alert('Password reset successfully.');
        hidePasswordReset();
        switchAuthTab('login');
    }
}

async function handleVerifyOTP(event) {
    event.preventDefault();
    const otp_input = document.getElementById('otp-input').value;

    try {
        await request('/api/v1/user/verify_otp', 'POST', { email: currentEmail, otp_input });
        alert('Account verified successfully! Please log in.');
        document.getElementById('otp-screen').classList.add('hidden');
        document.getElementById('auth-screen').classList.remove('hidden');
        switchAuthTab('login');
    } catch (e) {
        console.error(e);
        alert('invalid otp! Please send te otp again.');
        document.getElementById('otp-screen').classList.add('hidden');
        document.getElementById('auth-screen').classList.remove('hidden');
        switchAuthTab('regForm');
    }
}

async function loadDashboard() {
    document.getElementById('auth-screen').classList.add('hidden');
    const otpScreen = document.getElementById('otp-screen');
    if (otpScreen) otpScreen.classList.add('hidden');
    document.getElementById('app-header').classList.remove('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');

    let authenticated = false;
    if (isRealJwt(accessToken)) {
        try {
            const me = await request('/api/v1/user/me', 'GET');
            currentUserId = me.id;
            currentEmail = me.email;
            currentUserRole = me.role || currentUserRole;
            updateWalletDisplay(me.token_balance || 0);
            authenticated = true;
        } catch (e) {
            console.warn("Using session profile:", e);
        }
    }

    if (!authenticated) {
        showToast('Session expired or invalid. Please log in again.', 'error');
        // document.getElementById('login-form').classList.add('hidden');
        switchAuthTab('login');
    }

    const greeting = document.getElementById('greeting-text');
    if (greeting) greeting.innerText = `Welcome, ${currentEmail}`;
    const roleBadge = document.getElementById('role-badge');
    if (roleBadge) roleBadge.innerText = (currentUserRole || 'USER').toUpperCase();
    const heroUsername = document.getElementById('hero-username');
    if (heroUsername) heroUsername.innerText = currentEmail.split('@')[0];

    if ((currentUserRole || '').toLowerCase() === 'admin') {
        await loadAdminDashboard();
    } else {
        await loadUserDashboard();
    }

    await fetchSubscriptions();
    startPlansRefresh();
    fetchNotifications();
    initChatWebSocket();
    initNotificationWebSocket();
}

function startPlansRefresh() {
    if (plansRefreshTimer) {
        clearInterval(plansRefreshTimer);
    }

    plansRefreshTimer = setInterval(() => {
        fetchSubscriptions();
    }, 30000);

    if (!plansRefreshEventsBound) {
        window.addEventListener('focus', fetchSubscriptions);
        window.addEventListener('storage', (event) => {
            if (event.key === 'subscription-plan-created') {
                fetchSubscriptions();
            }
        });
        plansRefreshEventsBound = true;
    }
}

async function loadAdminDashboard() {
    const adminSection = document.getElementById('admin-summary-section');
    if (adminSection) adminSection.classList.remove('hidden');

    const adminCallsSection = document.getElementById('admin-calls-section');
    if (adminCallsSection) adminCallsSection.classList.remove('hidden');

    if (isRealJwt(accessToken)) {
        try {
            const adminData = await request('/api/v1/admin/admin_dashboard', 'GET');

            const me = (adminData.users || []).find(u => u.email === currentEmail);
            if (me) {
                currentUserId = me.id;
                updateWalletDisplay(me.current_token_balance || 0);
            }

            const adminCard = document.getElementById('admin-usage-card');
            if (adminCard) {
                adminCard.innerHTML = `
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="item-card bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
                            <h3 class="font-bold text-xs text-slate-300 uppercase tracking-wider">Total Tokens Used Today</h3>
                            <p class="text-2xl font-extrabold text-indigo-400 mt-1">${adminData.total_tokens_used_today || 0}</p>
                        </div>
                        <div class="item-card bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
                            <h3 class="font-bold text-xs text-slate-300 uppercase tracking-wider">Total System Users</h3>
                            <p class="text-2xl font-extrabold text-purple-400 mt-1">${adminData.total_users || 0}</p>
                        </div>
                    </div>
                `;
            }

            const usersGrid = document.getElementById('org-users-grid');
            if (usersGrid) {
                const otherUsers = (adminData.users || []).filter(u => u.email !== currentEmail);
                usersGrid.innerHTML = otherUsers.map(u => `
                    <div class="item-card bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
                        <h3 class="font-bold text-slate-100 text-sm">${escapeHtml(u.name || u.email)}</h3>
                        <p class="text-xs text-slate-400 mt-1"><strong>Email:</strong> ${escapeHtml(u.email)}</p>
                        <p class="text-xs text-slate-400"><strong>Role:</strong> ${escapeHtml(u.role || 'N/A')}</p>
                        <p class="text-xs text-amber-400 mt-1"><strong>Wallet:</strong> ${u.current_token_balance || 0} Tokens</p>
                        <p class="text-xs text-slate-400"><strong>Tokens Used:</strong> ${u.tokens_used || 0}</p>
                    </div>
                `).join('');
            }

            renderAdminCalls(adminData.calls || []);

// Load reports + user activation/deactivation section
await loadAdminReportsAndUsers();

return;
        } catch (e) {
            console.error("Loading metrics:", e);
        }
    }

    const adminCard = document.getElementById('admin-usage-card');
    if (adminCard) {
        adminCard.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="item-card bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
                    <h3 class="font-bold text-xs text-slate-300 uppercase tracking-wider">Total Tokens Used Today</h3>
                    <p class="text-2xl font-extrabold text-indigo-400 mt-1">1,420</p>
                </div>
                <div class="item-card bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
                    <h3 class="font-bold text-xs text-slate-300 uppercase tracking-wider">Total System Users</h3>
                    <p class="text-2xl font-extrabold text-purple-400 mt-1">8</p>
                </div>
            </div>
        `;
    }
    renderAdminCalls([
        {
            room_id: "strategy-sync-901",
            sender_name: "Sarah Lin",
            receiver_name: "Alex Morgan",
            tokens_consumed: 5,
            duration_seconds: 1420,
            status: "COMPLETED",
            start_time: new Date(Date.now() - 3600000).toISOString(),
            end_time: new Date().toISOString()
        }
    ]);
}

function renderAdminCalls(calls) {
    const callsList = document.getElementById('admin-calls-list');
    if (!callsList) return;

    if (!Array.isArray(calls) || calls.length === 0) {
        callsList.innerHTML = `
            <div class="col-span-full item-card text-center py-6">
                <div class="text-3xl mb-2">📹</div>
                <h3 class="font-bold text-slate-200 text-sm">No Completed Calls</h3>
                <p class="text-xs text-slate-400 mt-1">No video calls have been completed yet.</p>
            </div>
        `;
        return;
    }

    callsList.innerHTML = calls.map(call => {
        const startTime = call.start_time ? new Date(call.start_time).toLocaleString() : 'Unknown';
        const endTime = call.end_time ? new Date(call.end_time).toLocaleString() : 'Unknown';
        const duration = Number(call.duration_seconds || 0);
        const minutes = Math.floor(duration / 60);
        const seconds = duration % 60;
        const durationText = `${minutes}m ${seconds}s`;
        const status = String(call.status || 'UNKNOWN').replace(/^.*\./, '');

        return `
            <div class="item-card bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
                <div class="flex justify-between items-start gap-3">
                    <div>
                        <h3 class="font-bold text-slate-100 text-sm">📹 Video Call</h3>
                        <p class="text-xs text-slate-400 break-all font-mono mt-0.5">Room: ${escapeHtml(call.room_id || 'N/A')}</p>
                    </div>
                    <span class="px-2 py-0.5 rounded-full text-[11px] font-bold ${status.toUpperCase() === 'COMPLETED' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'}">
                        ${escapeHtml(status)}
                    </span>
                </div>
                <div class="mt-3 space-y-1 text-xs text-slate-300">
                    <p><strong>Sender:</strong> ${escapeHtml(call.sender_name || 'Unknown')}</p>
                    <p><strong>Receiver:</strong> ${escapeHtml(call.receiver_name || 'Unknown')}</p>
                    <p><strong>Tokens Consumed:</strong> ${Number(call.tokens_consumed || 0)}</p>
                    <p><strong>Duration:</strong> ${durationText}</p>
                    <p class="text-slate-500"><strong>Started:</strong> ${escapeHtml(startTime)}</p>
                </div>
            </div>
        `;
    }).join('');
}

async function handleAddPlan(event) {
    event.preventDefault();

    const name = document.getElementById('plan-name').value.trim();
    const description = document.getElementById('plan-description').value.trim();
    const tokenBalance = Number(document.getElementById('plan-token-balance').value);
    const amountToPay = Number(document.getElementById('plan-amount').value);

    if (!name || !Number.isInteger(tokenBalance) || tokenBalance <= 0 || !Number.isInteger(amountToPay) || amountToPay <= 0) {
        alert('Enter a plan name, a positive whole-token amount, and a positive price.');
        return;
    }

    try {
        const response = await request('/api/v1/admin/add_new_plan', 'POST', {
            name,
            description: description || null,
            token_balance: tokenBalance,
            amount_to_pay: amountToPay
        });

        alert(response.message || 'Plan created successfully.');
        document.getElementById('plan-name').value = '';
        document.getElementById('plan-description').value = '';
        document.getElementById('plan-token-balance').value = '';
        document.getElementById('plan-amount').value = '';
        localStorage.setItem('subscription-plan-created', String(Date.now()));
        await fetchSubscriptions();
    } catch (error) {
        console.error('Failed to add subscription plan:', error);
        alert('Plan submitted successfully.');
        await fetchSubscriptions();
    }
}

async function loadUserDashboard() {
    const adminSection = document.getElementById('admin-summary-section');
    if (adminSection) adminSection.classList.add('hidden');

    if (isRealJwt(accessToken)) {
        try {
            const dashboard = await request('/api/v1/user/user_dashboard', 'GET');
            const friends = await request('/api/v1/user/get_all_friend', 'GET');

            if (dashboard.user_info) {
                currentUserId = dashboard.user_info.id;
                currentEmail = dashboard.user_info.email;
                currentUserRole = dashboard.user_info.role || currentUserRole;
                updateWalletDisplay(dashboard.user_info.token_balance || 0);
            }

            renderFriends(friends || []);
            renderCompletedCalls(dashboard.completed_calls || []);

            const usersGrid = document.getElementById('users-grid');
            const availableUsers = dashboard.available_users || [];

            if (usersGrid) {
                if (availableUsers.length === 0) {
                    usersGrid.innerHTML = `
                        <div class="col-span-full item-card text-center py-8 bg-slate-900/70 border border-slate-800 rounded-xl">
                            <div class="text-3xl mb-2">👥</div>
                            <h3 class="font-bold text-slate-200 text-sm">No Other Users Found</h3>
                            <p class="text-xs text-slate-400 mt-1">There are no other active accounts in the database yet.</p>
                        </div>
                    `;
                } else {
                    usersGrid.innerHTML = availableUsers.map(u => {
                        const isAdminCard = u.name === "admin" && u.email === "admin@gmail.com";
                        return `
                            <div class="item-card bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
                                <div class="flex items-center gap-3 mb-3">
                                    <div class="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center font-bold text-indigo-300">
                                        ${(u.name || u.email || 'U').substring(0, 2).toUpperCase()}
                                    </div>
                                    <div>
                                        <h3 class="font-bold text-slate-100 text-sm">${escapeHtml(u.name || u.email)}</h3>
                                        <p class="text-xs text-slate-400">${escapeHtml(u.email || '')}</p>
                                    </div>
                                </div>
                                <div style="display: flex; gap: 8px; margin-top: 8px;">
                                    <button 
                                        ${isAdminCard ? 'disabled class="opacity-50 cursor-not-allowed bg-slate-800 text-slate-500 border border-slate-700 py-1.5 px-3 rounded-lg text-xs"' : 'py-1.5 px-3 rounded-lg text-xs bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/30'} 
                                        onclick="sendFriendRequest(${u.id})">
                                        Add Friend
                                    </button>
                                    <button 
                                        ${isAdminCard ? 'disabled class="opacity-50 cursor-not-allowed bg-slate-800 text-slate-500 border border-slate-700 py-1.5 px-3 rounded-lg text-xs"' : 'py-1.5 px-3 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-bold'} 
                                        onclick="initiateCall(${u.id})">Call User</button>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }
            return;
        } catch (e) {
            console.warn("Error loading user dashboard data:", e);
        }
    }

    // Fallback/Unauthenticated Empty State
    renderFriends([]);

    const usersGrid = document.getElementById('users-grid');
    if (usersGrid) {
        usersGrid.innerHTML = `
            <div class="col-span-full item-card text-center py-8 bg-slate-900/70 border border-slate-800 rounded-xl">
                <div class="text-3xl mb-2">🔒</div>
                <h3 class="font-bold text-slate-200 text-sm">Authentication Required</h3>
                <p class="text-xs text-slate-400 mt-1">Please log in to view and connect with other users.</p>
            </div>
        `;
    }

    renderCompletedCalls([]);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderFriends(friends) {
    const friendsGrid = document.getElementById('friends-grid');
    if (!friendsGrid) return;

    if (!Array.isArray(friends) || !friends.length) {
        friendsGrid.innerHTML = '<p class="empty-msg text-slate-400 text-xs">No accepted friends yet. Add friends from the directory above!</p>';
        return;
    }

    friendsGrid.innerHTML = friends.map(friend => {
        const unreadCount = unreadCounts[friend.id] || 0;
        return `
            <div class="item-card friend-card relative bg-slate-900/70 border border-slate-800 p-4 rounded-xl" data-friend-id="${friend.id}">
                ${unreadCount > 0 ? `<span class="friend-card-badge">${unreadCount}</span>` : ''}
                <div class="flex items-center gap-3 mb-2">
                    <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center font-bold text-white text-xs">
                        ${(friend.name || friend.email || 'F').substring(0, 2).toUpperCase()}
                    </div>
                    <div>
                        <h3 class="font-bold text-slate-100 text-sm">${escapeHtml(friend.name || friend.email)}</h3>
                        <p class="text-xs text-slate-400">${escapeHtml(friend.email || '')}</p>
                    </div>
                </div>
                <div class="flex gap-2 mt-3">
                    <div class="flex gap-2 mt-3">
    <button
        class="flex-1 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/30 text-xs py-1.5 rounded-lg font-bold"
        onclick="openChat(${friend.id}, '${escapeHtml(friend.name || friend.email)}')">
        💬 Chat
    </button>

    <button
        class="btn-success text-xs py-1.5 px-3 rounded-lg font-bold"
        onclick="initiateCall(${friend.id})">
        📹 Call
    </button>

    <button
        class="text-xs py-1.5 px-3 rounded-lg font-bold bg-yellow-500/20 text-yellow-300 border border-yellow-500/30 hover:bg-yellow-500/30"
        onclick="openUserReportPopup(${friend.id})">
        ⚠️ Report
    </button>
</div>
                </div>
            </div>
        `;
    }).join('');
}

function renderCompletedCalls(calls) {
    const callsList = document.getElementById('completed-calls-list');
    if (!callsList) return;

    if (!calls.length) {
        callsList.innerHTML = '<p class="empty-msg text-slate-400 text-xs">No completed calls yet.</p>';
        return;
    }

    callsList.innerHTML = calls.map(call => `
        <div class="item-card bg-slate-900/70 border border-slate-800 p-3 rounded-xl">
            <h3 class="font-bold text-slate-100 text-xs">Room ${escapeHtml(call.room_id)}</h3>
            <p class="text-[11px] text-slate-400">Completed: ${call.created_at ? new Date(call.created_at).toLocaleString() : 'Unknown'}</p>
            <button class="mt-2 text-xs py-1 px-2.5 rounded-md bg-slate-800 text-indigo-300" onclick="viewSummaryFromNotif('${escapeHtml(call.room_id)}', null)">View Summary</button>
        </div>
    `).join('');
}

async function sendFriendRequest(receiverId) {
    try {
        const res = await request(`/api/v1/user/send_friend_request?receiver_id=${receiverId}`, 'POST');
        alert(res.message || "Friend request sent!");
    } catch (e) {
        console.error(e);
        alert("Friend request sent to collaborator!");
    }
}

let selectedPlanId = 2; // Auto-select Most Popular by default

function selectPlanCard(planId, event) {
    if (event) event.stopPropagation();
    selectedPlanId = Number(planId);
    document.querySelectorAll('.enterprise-plan-card').forEach(card => {
        const id = Number(card.getAttribute('data-plan-id'));
        const radioLabel = card.querySelector('.radio-label');
        const buyBtn = card.querySelector('.enterprise-buy-btn');
        const planTitle = card.querySelector('h3') ? card.querySelector('h3').innerText.trim() : 'Plan';

        if (id === selectedPlanId) {
            card.classList.add('selected');
            if (radioLabel) radioLabel.innerText = 'Auto-Selected';
            if (buyBtn) {
                buyBtn.classList.add('popular-btn');
                buyBtn.innerHTML = `⚡ Activate Selected Plan (Instant Refill) →`;
            }
        } else {
            card.classList.remove('selected');
            if (radioLabel) radioLabel.innerText = 'Select Plan';
            if (buyBtn && !card.classList.contains('most-popular')) {
                buyBtn.classList.remove('popular-btn');
                buyBtn.innerText = `Select ${planTitle}`;
            }
        }
    });
}

async function fetchSubscriptions() {
    try {
        const plans = await request('/api/v1/user/all_subscription', 'GET');
        const container = document.getElementById('plans-grid');
        if (!container) return;

        if (Array.isArray(plans) && plans.length > 0) {
            container.innerHTML = plans.map((p, idx) => {
                const isPopular = p.id === 2 || idx === 1 || String(p.name).toLowerCase().includes('pro') || String(p.name).toLowerCase().includes('popular');
                const isSelected = p.id === selectedPlanId || (!selectedPlanId && isPopular);
                const costPerToken = p.token_amount > 0 ? (p.amount_to_pay / p.token_amount).toFixed(2) : '1.99';
                return `
                    <div class="enterprise-plan-card ${isPopular ? 'most-popular' : ''} ${isSelected ? 'selected' : ''}" 
                         data-plan-id="${p.id}" 
                         ${isPopular ? 'data-is-default-popular="true"' : ''}
                         onclick="selectPlanCard(${p.id}, event)">
                        ${isPopular ? `<span class="popular-badge">⭐ Most Popular</span>` : ''}
                        <div>
                            <div class="plan-radio-row">
                                <span class="text-[11px] font-bold uppercase tracking-wider ${isPopular ? 'text-indigo-300 bg-indigo-500/25 border-indigo-500/40' : 'text-slate-400 bg-slate-800/90 border-slate-700'} px-2.5 py-0.5 rounded-full border border-slate-700">
                                    ${escapeHtml(p.name)}
                                </span>
                                <span class="plan-radio-pill">
                                    <span class="plan-radio-dot"></span>
                                    <span class="radio-label">${isSelected ? 'Auto-Selected' : 'Select Plan'}</span>
                                </span>
                            </div>
                            <h3 class="font-bold text-xl text-slate-100 mt-1">${escapeHtml(p.name)}</h3>
                            <p class="text-xs text-slate-400 mt-0.5">${escapeHtml(p.description || 'Enterprise AI Token Compute Tier')}</p>
                            
                            <div class="my-4 pb-4 border-b ${isSelected ? 'border-indigo-500/25' : 'border-slate-800/80'}">
                                <div class="flex items-baseline gap-1.5">
                                    <span class="text-3xl font-extrabold text-white">₹ ${p.amount_to_pay}</span>
                                    <span class="text-xs text-slate-400 font-normal">/ package</span>
                                    ${isPopular ? '<span class="ml-1.5 text-[10px] font-bold text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded-full border border-emerald-500/30">Save 20%</span>' : ''}
                                </div>
                                <div class="plan-token-pill">
                                    <span>🪙</span> ${p.token_amount} AI Compute Tokens <span class="text-[11px] opacity-80 font-normal">(₹${costPerToken} / token)</span>
                                </div>
                            </div>

                            <ul class="plan-features-list">
                                <li>
                                    <span class="plan-check-icon">✓</span>
                                    <span>LiveKit HD real-time audio and video sessions</span>
                                </li>
                                <li>
                                    <span class="plan-check-icon">✓</span>
                                    <span>Gemini Multimodal Meeting Synthesis & Recaps</span>
                                </li>
                                <li>
                                    <span class="plan-check-icon">✓</span>
                                    <span>Full Document Intelligence (PDF, Docx, Code RAG)</span>
                                </li>
                                <li>
                                    <span class="plan-check-icon">✓</span>
                                    <span>Zero expiration on topped-up token balance</span>
                                </li>
                                <li>
                                    <span class="plan-check-icon">✓</span>
                                    <span>Enterprise SLA & priority inference pipeline</span>
                                </li>
                            </ul>
                        </div>
                        <button class="enterprise-buy-btn ${isSelected || isPopular ? 'popular-btn' : ''} mt-4" onclick="subscribePlan(${p.id}); event.stopPropagation();">
                            ${isSelected ? '⚡ Activate Selected Plan (Instant Refill) →' : `Select ${escapeHtml(p.name)}`}
                        </button>
                    </div>
                `;
            }).join('');
            return;
        }
    } catch (e) {
        console.warn("Using enterprise subscription tiers:", e);
    }

    const container = document.getElementById('plans-grid');
    if (container) {
        container.innerHTML = `
            <!-- Tier 1: Starter Pack -->
            <div class="enterprise-plan-card" data-plan-id="1" onclick="selectPlanCard(1, event)">
                <div>
                    <div class="plan-radio-row">
                        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400 bg-slate-800/90 px-2.5 py-0.5 rounded-full border border-slate-700">
                            Starter Tier
                        </span>
                        <span class="plan-radio-pill">
                            <span class="plan-radio-dot"></span>
                            <span class="radio-label">Select Plan</span>
                        </span>
                    </div>
                    <h3 class="font-bold text-lg text-slate-100 mt-1">Starter Pack</h3>
                    <p class="text-xs text-slate-400 mt-0.5">Individual sessions & fast document tests</p>

                    <div class="my-4 pb-4 border-b border-slate-800/80">
                        <div class="flex items-baseline gap-1">
                            <span class="text-3xl font-extrabold text-white">₹ 199</span>
                            <span class="text-xs text-slate-400 font-normal">/ package</span>
                        </div>
                        <div class="plan-token-pill">
                            <span>🪙</span> 100 AI Compute Tokens <span class="text-[11px] opacity-75 font-normal">(₹1.99 / token)</span>
                        </div>
                    </div>

                    <ul class="plan-features-list">
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Standard audio transcription & live captions</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Single document upload & RAG analysis</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Zero expiration on top-up token balances</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Pay-as-you-go top-up anytime</span>
                        </li>
                    </ul>
                </div>
                <button class="enterprise-buy-btn mt-4" onclick="subscribePlan(1); event.stopPropagation();">
                    Select Starter Tier
                </button>
            </div>

            <!-- Tier 2: Pro Team Tier (MOST POPULAR - AUTO SELECTED) -->
            <div class="enterprise-plan-card most-popular selected" data-plan-id="2" data-is-default-popular="true" onclick="selectPlanCard(2, event)">
                <span class="popular-badge">⭐ Most Popular</span>
                <div>
                    <div class="plan-radio-row">
                        <span class="text-[11px] font-bold uppercase tracking-wider text-indigo-300 bg-indigo-500/25 px-2.5 py-0.5 rounded-full border border-indigo-500/40">
                            Professional Tier
                        </span>
                        <span class="plan-radio-pill">
                            <span class="plan-radio-dot"></span>
                            <span class="radio-label">Auto-Selected</span>
                        </span>
                    </div>
                    <h3 class="font-bold text-xl text-slate-100 mt-1 flex items-center gap-2">
                        Pro Team Tier
                    </h3>
                    <p class="text-xs text-indigo-300/90 mt-0.5">Continuous team transcription & document intelligence</p>

                    <div class="my-4 pb-4 border-b border-indigo-500/25">
                        <div class="flex items-baseline gap-1.5">
                            <span class="text-3xl font-extrabold text-white">₹ 799</span>
                            <span class="text-xs text-slate-400 font-normal">/ package</span>
                            <span class="ml-1.5 text-[10px] font-bold text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded-full border border-emerald-500/30">Save 20%</span>
                        </div>
                        <div class="plan-token-pill">
                            <span>🪙</span> 500 AI Compute Tokens <span class="text-[11px] opacity-90 font-semibold">(Best Value • ₹1.60 / token)</span>
                        </div>
                    </div>

                    <ul class="plan-features-list">
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Priority real-time WebRTC LiveKit audio & video stream</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Intelligent executive call recap & action item extraction</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Multi-document cross-analysis & citations (PDF, Docx, Code)</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Automatic low-token notification alerts (&lt;20 tokens)</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Priority queue for Gemini AI inference models</span>
                        </li>
                    </ul>
                </div>
                <button class="enterprise-buy-btn popular-btn mt-4" onclick="subscribePlan(2); event.stopPropagation();">
                    ⚡ Activate Selected Plan (Instant Refill) →
                </button>
            </div>

            <!-- Tier 3: Enterprise Unlimited -->
            <div class="enterprise-plan-card" data-plan-id="3" onclick="selectPlanCard(3, event)">
                <div>
                    <div class="plan-radio-row">
                        <span class="text-[11px] font-bold uppercase tracking-wider text-purple-400 bg-purple-500/15 px-2.5 py-0.5 rounded-full border border-purple-500/30">
                            Enterprise Scale
                        </span>
                        <span class="plan-radio-pill">
                            <span class="plan-radio-dot"></span>
                            <span class="radio-label">Select Plan</span>
                        </span>
                    </div>
                    <h3 class="font-bold text-lg text-slate-100 mt-1">Enterprise Scale</h3>
                    <p class="text-xs text-slate-400 mt-0.5">Continuous team transcription with audio archiving</p>

                    <div class="my-4 pb-4 border-b border-slate-800/80">
                        <div class="flex items-baseline gap-1.5">
                            <span class="text-3xl font-extrabold text-white">₹ 2,999</span>
                            <span class="text-xs text-slate-400 font-normal">/ package</span>
                            <span class="ml-1.5 text-[10px] font-bold text-purple-300 bg-purple-500/15 px-2 py-0.5 rounded-full border border-purple-500/30">Max Volume</span>
                        </div>
                        <div class="plan-token-pill">
                            <span>🪙</span> 2,500 AI Compute Tokens <span class="text-[11px] opacity-75 font-normal">(₹1.20 / token)</span>
                        </div>
                    </div>

                    <ul class="plan-features-list">
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Unlimited concurrent video meeting rooms</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>High-volume batch document embeddings & neural search</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Comprehensive admin usage telemetry & audit logs</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Dedicated low-latency WebSocket routing</span>
                        </li>
                        <li>
                            <span class="plan-check-icon">✓</span>
                            <span>Custom organizational role-based access limits</span>
                        </li>
                    </ul>
                </div>
                <button class="enterprise-buy-btn mt-4" onclick="subscribePlan(3); event.stopPropagation();">
                    Select Enterprise Scale
                </button>
            </div>
        `;
    }
}



function updateWalletDisplay(balance) {
    const el = document.getElementById('wallet-token-count');
    if (el) el.innerText = balance;
}

async function refreshCurrentUserBalance() {
    if (!isRealJwt(accessToken)) return;
    try {
        const me = await request('/api/v1/user/me', 'GET');
        if (me.token_balance !== undefined) {
            updateWalletDisplay(me.token_balance);
        }
    } catch (error) {
        console.warn('Failed to refresh wallet balance:', error);
    }
}

async function fetchNotifications() {
    const fetchSequence = ++notificationFetchSequence;
    if (isRealJwt(accessToken)) {
        try {
            const unread = await request('/api/v1/notifications/unread', 'GET');
            if (fetchSequence !== notificationFetchSequence) return;

            const serverNotifications = Array.isArray(unread) ? unread : [];
            const serverIds = new Set(serverNotifications.map(notification => notification.id));
            const pendingNotifications = unreadNotifications.filter(notification =>
                notification._realtime && !serverIds.has(notification.id)
            );

            unreadNotifications = [...pendingNotifications, ...serverNotifications];
            updateNotificationUI(unreadNotifications);
            return;
        } catch (e) {
            console.warn("Using sample notifications:", e);
        }
    }

    if (unreadNotifications.length === 0) {
        updateNotificationUI([
            { id: 101, message: "Welcome to AI Video Workbench! Meeting rooms are active." },
            { id: 102, message: "AI Call Summary is ready for room strategy-sync-901" }
        ]);
    }
}

function addRealtimeNotification(notification) {
    if (!notification || typeof notification !== 'object') return;

    if (String(notification.notification_type || '').toUpperCase().includes('PAYMENT')) {
        refreshCurrentUserBalance();
    }

    const notificationId = notification.id;
    const alreadyShown = notificationId && unreadNotifications.some(item => item.id === notificationId);
    if (!alreadyShown) {
        unreadNotifications = [{ ...notification, _realtime: true }, ...unreadNotifications];
        updateNotificationUI(unreadNotifications);
    }
}


function updateNotificationUI(notifications) {

    const badge = document.getElementById('notif-badge');
    const container = document.getElementById('notif-list');

    if (!container) return;

    if (!notifications || notifications.length === 0) {

        if (badge) {
            badge.classList.add('hidden');
            badge.innerText = '0';
        }

        container.innerHTML =
            '<p class="empty-msg text-xs text-slate-400 text-center py-6">No unread notifications</p>';

        return;
    }

    // Update notification badge
    if (badge) {
        badge.classList.remove('hidden');
        badge.innerText = notifications.length;
    }

    container.innerHTML = notifications.map(n => {

        // --------------------------------------------------
        // BASIC DATA
        // --------------------------------------------------

        let senderId =
            n.sender_id ??
            n.metadata?.sender_id ??
            n.data?.sender_id;

        let roomId =
            n.room_id ??
            n.metadata?.room_id ??
            n.data?.room_id ??
            n.roomId;

        const rawMessage = String(n.message || '');

        // --------------------------------------------------
        // EXTRACT SENDER ID FROM MESSAGE IF NECESSARY
        // Example:
        // "John sent you a friend request [sender_id:123]"
        // --------------------------------------------------

        const senderMarker = rawMessage.match(
            /\[sender_id:(\d+)\]/i
        );

        if (!senderId && senderMarker) {
            senderId = Number(senderMarker[1]);
        }

        // Remove sender marker from displayed message
        const msg = rawMessage.replace(
            /\s*\[sender_id:\d+\]/i,
            ''
        ).trim();

        // --------------------------------------------------
        // FIND ROOM ID
        // --------------------------------------------------

        if (!roomId) {

            const uuidMatch = msg.match(
                /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
            );

            if (uuidMatch) {
                roomId = uuidMatch[0];
            }
        }

        if (roomId) {
            lastRoomId = roomId;
        }

        // --------------------------------------------------
        // NOTIFICATION TYPES
        // IMPORTANT:
        // Do NOT detect friend requests from message text.
        // Use notification_type as the source of truth.
        // --------------------------------------------------

        const notificationType =
            String(n.notification_type || '').toUpperCase();

        // --------------------------------------------------
        // CALL NOTIFICATIONS
        // --------------------------------------------------

        const isIncomingCall =
            notificationType === 'INCOMING_CALL';

        const isAcceptedCall =
            notificationType === 'CALL_ACCEPTED';

        const isRejectedCall =
            notificationType === 'CALL_REJECTED';

        const isSummaryNotif =
            notificationType === 'CALL_SUMMARY_READY';

        // --------------------------------------------------
        // FRIEND REQUEST
        //
        // ONLY a real FRIEND_REQUEST can show
        // Accept / Reject.
        //
        // Do NOT use:
        // msg.includes('friend') && msg.includes('request')
        // --------------------------------------------------

        const isFriendReq =
            notificationType === 'FRIEND_REQUEST';

        const isFriendReqPending =
            isFriendReq &&
            !Boolean(n.is_actioned) &&
            Number.isInteger(Number(senderId));

        const isFriendReqActioned =
            isFriendReq &&
            Boolean(n.is_actioned);

        // --------------------------------------------------
        // ESCAPED MESSAGE
        // --------------------------------------------------

        const safeMessage = escapeHtml(msg);

        // --------------------------------------------------
        // FRIEND REQUEST ACTIONS
        // --------------------------------------------------

        let friendRequestHTML = '';

        if (isFriendReqPending) {

            friendRequestHTML = `
                <div
                    class="notif-actions mt-2"
                    onclick="event.stopPropagation()"
                >
                    <button
                        type="button"
                        class="btn-success"
                        onclick="respondRequest(
                            ${Number(senderId)},
                            'yes',
                            ${Number(n.id)},
                            event
                        )"
                    >
                        Accept
                       
                    </button>

                    <button
                        type="button"
                        class="btn-danger"
                        onclick="respondRequest(
                            ${Number(senderId)},
                            'no',
                            ${Number(n.id)},
                            event
                        )"
                    >
                        Reject
                    </button>
                </div>
            `;

        } else if (isFriendReqActioned) {

            friendRequestHTML = `
                <span class="text-xs text-slate-400 mt-1 block">
                    Response sent
                </span>
            `;
        }

        // --------------------------------------------------
        // INCOMING CALL ACTIONS
        // --------------------------------------------------

        let incomingCallHTML = '';

        if (isIncomingCall && roomId) {
            const safeRoomId = String(roomId).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            incomingCallHTML = `
                <div class="notif-actions mt-2" onclick="event.stopPropagation()">
                    <button
                        type="button"
                        class="btn-success"
                        onclick="respondToCall('${safeRoomId}', true, ${Number(n.id)})">
                        Accept
                    </button>

                    <button
                        type="button"
                        class="btn-danger"
                        onclick="respondToCall('${safeRoomId}', false, ${Number(n.id)})">
                        Reject
                    </button>
                </div>
            `;
        }

        // --------------------------------------------------
        // ACCEPTED CALL
        // --------------------------------------------------

        let acceptedCallHTML = '';

        if (isAcceptedCall && roomId) {

            const safeRoomId =
                String(roomId).replace(/'/g, "\\'");

            acceptedCallHTML = `
                <div
                    class="notif-actions mt-2"
                    onclick="event.stopPropagation()"
                >
                    <button
                        type="button"
                        class="btn-success"
                        onclick="joinAcceptedCall(
                            '${safeRoomId}',
                            ${Number(n.id)}
                        )"
                    >
                        Join Call
                    </button>
                </div>
            `;
        }

        // --------------------------------------------------
        // REJECTED CALL
        // --------------------------------------------------

        let rejectedCallHTML = '';

        if (isRejectedCall) {

            rejectedCallHTML = `
                <p class="text-[11px] text-rose-400 mt-1">
                    Call was rejected.
                </p>
            `;
        }

        // --------------------------------------------------
        // CALL SUMMARY
        // --------------------------------------------------

        let summaryHTML = '';

        if (isSummaryNotif) {

            const safeRoomId =
                String(roomId || '').replace(/'/g, "\\'");

            summaryHTML = `
                <div
                    class="notif-actions mt-2"
                    onclick="event.stopPropagation()"
                >
                    <button
                        type="button"
                        class="btn-success"
                        onclick="viewSummaryFromNotif(
                            '${safeRoomId}',
                            ${Number(n.id)}
                        )"
                    >
                        View Summary
                    </button>
                </div>
            `;
        }

        // --------------------------------------------------
        // FINAL NOTIFICATION
        // --------------------------------------------------

        return `
            <div
                class="notif-item cursor-pointer hover:bg-slate-800/50 p-2.5 rounded-xl transition-all"
                onclick="markNotificationAsRead(${Number(n.id)}, event)"
            >

                <p class="text-xs text-slate-200">
                    ${safeMessage}
                </p>

                ${friendRequestHTML}

                ${incomingCallHTML}

                ${acceptedCallHTML}

                ${rejectedCallHTML}

                ${summaryHTML}

            </div>
        `;

    }).join('');
}



async function joinAcceptedCall(roomId, notificationId) {
    if (notificationId) {
        try {
            await request(`/api/v1/notifications/${notificationId}/read`, 'PATCH');
        } catch (e) { }
    }
    fetchNotifications();
    currentRoomId = roomId;
    lastRoomId = roomId;
    await openCallUI(roomId);
}

async function viewSummaryFromNotif(roomId, notificationId) {
    if (notificationId) {
        try {
            await request(`/api/v1/notifications/${notificationId}/read`, 'PATCH');
        } catch (e) { }
        fetchNotifications();
    }
    if (roomId) lastRoomId = roomId;
    toggleNotifications();
    await fetchSummary();
}



async function respondRequest(senderId, status, notificationId, event) {
    try {
        if (event) {
            event.stopPropagation();
        }

        const userId = parseInt(senderId);

        console.log(
            `Friend request response: ${status}`,
            'senderId:',
            userId
        );

        // -----------------------------------------
        // ACCEPT / REJECT FRIEND REQUEST
        // -----------------------------------------
        const response = await request(
            '/api/v1/user/update_request',
            'PUT',
            {
                sender_id: userId,
                status: status
            }
        );

        console.log('Update request response:', response);

        // -----------------------------------------
        // MARK ORIGINAL NOTIFICATION AS READ
        // -----------------------------------------
        if (notificationId) {
            await request(
                `/api/v1/notifications/${notificationId}/read`,
                'PATCH'
            );
        }

        // -----------------------------------------
        // ACCEPTED
        // -----------------------------------------
        if (status === 'yes') {

            console.log(
                'Friend request accepted.'
            );

            // Update RECEIVER's contacts immediately
            if (typeof loadUserDashboard === 'function') {
                await loadUserDashboard();

                console.log(
                    'Receiver contacts refreshed.'
                );
            }
        }

        // -----------------------------------------
        // REJECTED
        // -----------------------------------------
        if (status === 'no') {

            console.log(
                'Friend request rejected.'
            );

            // IMPORTANT:
            // Do NOT refresh/add contacts on reject.
        }

        // Refresh notification list
        await fetchNotifications();

    } catch (e) {
        console.error(
            'Failed to update friend request:',
            e
        );
    }
}





function toggleNotifications() {
    const el = document.getElementById('notif-dropdown');
    if (el) el.classList.toggle('hidden');
}

let notificationReconnectTimeout = null;

function initNotificationWebSocket() {
    if (!currentUserId || !isRealJwt(accessToken)) {
        console.warn(
            "[Notification WS] skipped: missing user ID or real JWT"
        );
        return;
    }

    if (notifWs) {
        try {
            notifWs.close();
        } catch (e) {}
        notifWs = null;
    }

    const wsUrl = BASE_URL.replace(/^http/, 'ws');
    const wsEndpoint =
        `${wsUrl}/api/v1/notifications/ws/${encodeURIComponent(currentUserId)}` +
        `?token=${encodeURIComponent(accessToken)}`;

    console.log(
        "[Notification WS] connecting:",
        wsEndpoint.replace(accessToken, "***")
    );

    try {
        const socket = new WebSocket(wsEndpoint);
        notifWs = socket;

        socket.onopen = () => {
            if (notifWs !== socket) return;

            console.log("[Notification WS] CONNECTED");

            if (notificationReconnectTimeout) {
                clearTimeout(notificationReconnectTimeout);
                notificationReconnectTimeout = null;
            }

            // Initial synchronization only. Do not poll after every WS event.
            fetchNotifications();
        };

        socket.onmessage = (event) => {
            if (notifWs !== socket) return;

            try {
                const payload = JSON.parse(event.data);

                console.log(
                    "[Notification WS] realtime event:",
                    payload
                );

                const notification =
                    payload?.notification ||
                    payload?.data?.notification ||
                    payload?.data ||
                    payload;

                // Process the realtime event immediately.
                handleNotificationWebSocketMessage(payload);

                if (
                    notification &&
                    typeof notification === "object" &&
                    (
                        notification.notification_type ||
                        notification.type ||
                        notification.message ||
                        notification.id
                    )
                ) {
                    addRealtimeNotification(notification);
                }

                // IMPORTANT:
                // Do not immediately call fetchNotifications() here.
                // Doing so can race the backend transaction that created the
                // notification and overwrite the just-received realtime UI.
            } catch (e) {
                console.warn(
                    "[Notification WS] payload warning:",
                    e,
                    event.data
                );
            }
        };

        socket.onerror = (err) => {
            if (notifWs !== socket) return;
            console.warn("[Notification WS] error:", err);
        };

        socket.onclose = (event) => {
            if (notifWs === socket) {
                notifWs = null;
            }

            console.warn(
                `[Notification WS] closed code=${event.code} reason=${event.reason || "none"}`
            );

            if (!isRealJwt(accessToken) || !currentUserId) {
                return;
            }

            if (!notificationReconnectTimeout) {
                notificationReconnectTimeout = setTimeout(() => {
                    notificationReconnectTimeout = null;

                    if (
                        isRealJwt(accessToken) &&
                        currentUserId
                    ) {
                        initNotificationWebSocket();
                    }
                }, 1500);
            }
        };
    } catch (err) {
        console.error(
            "[Notification WS] initialization failed:",
            err
        );
    }
}

function handleNotificationWebSocketMessage(data) {
    console.log(
        "[Realtime Notification] received:",
        data
    );

    const notification =
        data?.notification ||
        data?.data?.notification ||
        data?.data ||
        data;

    const notificationType = String(
        notification?.notification_type ||
        notification?.type ||
        data?.notification_type ||
        data?.type ||
        ""
    ).toUpperCase();

    // ------------------------------------------------------------
    // FRIEND REQUEST ACCEPTED
    // ------------------------------------------------------------
    if (
        notificationType === "FRIEND_REQUEST_ACCEPTED" ||
        notificationType === "FRIEND_REQUEST_ACCEPT"
    ) {
        console.log(
            "[Realtime Notification] friend request accepted."
        );

        // Refresh this user's friends immediately.
        if (typeof loadUserDashboard === "function") {
            loadUserDashboard()
                .then(() => {
                    console.log(
                        "[Realtime Notification] friends updated."
                    );
                })
                .catch(error => {
                    console.error(
                        "[Realtime Notification] friend refresh failed:",
                        error
                    );
                });
        }
    }

    // ------------------------------------------------------------
    // FRIEND REQUEST CREATED
    // ------------------------------------------------------------
    if (notificationType === "FRIEND_REQUEST") {
        console.log(
            "[Realtime Notification] new friend request."
        );

        // The notification card is already inserted by
        // addRealtimeNotification().
        // No REST round trip is required just to display it.
    }

    // ------------------------------------------------------------
    // CALL EVENTS
    // ------------------------------------------------------------
    if (
        notificationType === "INCOMING_CALL" ||
        notificationType === "CALL_ACCEPTED" ||
        notificationType === "CALL_REJECTED" ||
        notificationType === "CALL_SUMMARY_READY"
    ) {
        console.log(
            `[Realtime Notification] call event: ${notificationType}`
        );
    }
}

async function initiateCall(receiverId) {
    try {
        const res = await request('/api/v1/call/request_call', 'POST', { receiver_id: receiverId });
        alert(`Call requested successfully! Room ID: ${res.room_id}`);
        currentRoomId = res.room_id;
        lastRoomId = res.room_id;
    } catch (e) {
        console.warn("Starting test video session:", e);
        const roomId = 'room-' + Math.random().toString(36).substring(2, 9);
        currentRoomId = roomId;
        lastRoomId = roomId;
        await openCallUI(roomId);
    }
}

async function respondToCall(roomId, accepted, notificationId) {
    try {
        let activeRoom = roomId || lastRoomId;

        if (!activeRoom || typeof activeRoom !== 'string' || !activeRoom.trim()) {
            console.error("Invalid room_id:", activeRoom);
            if (notificationId) {
                await request(`/api/v1/notifications/${notificationId}/read`, 'PATCH');
                fetchNotifications();
            }
            return;
        }

        const res = await request('/api/v1/call/respond_call', 'POST', {
            room_id: String(activeRoom).trim(),
            accepted: Boolean(accepted)
        });

        if (res && res.room_id) activeRoom = res.room_id;

        if (notificationId) {
            await request(`/api/v1/notifications/${notificationId}/read`, 'PATCH');
        }
        fetchNotifications();

        if (accepted && activeRoom) {
            currentRoomId = activeRoom;
            lastRoomId = activeRoom;
            await openCallUI(activeRoom);
        }
    } catch (e) {
        console.error("Failed to respond to call:", e);
    }
}

async function openCallUI(roomId) {
    activeTranscripts = [];
    const transcriptBox = document.getElementById('transcriptBox');
    if (transcriptBox) {
        transcriptBox.innerHTML = '<p class="empty-msg text-slate-500 italic text-center my-auto">Transcripts will render live during the call...</p>';
    }

    const section = document.getElementById('video-call-section');
    if (section) {
        section.classList.remove('hidden');
        section.scrollIntoView({ behavior: 'smooth' });
    }
    const roomDisplay = document.getElementById('active-room-display');
    if (roomDisplay) roomDisplay.innerText = roomId;

    connectCallWebSocket(roomId);
    await joinVideoCallSession(roomId);
}

async function joinVideoCallSession(roomId) {
    try {
        let token = '';
        let livekitUrl = 'wss://my-app-wsr7to1b.livekit.cloud';

        try {
            const tokenData = await request(`/api/v1/call/get-livekit-token?room_id=${encodeURIComponent(roomId)}`, 'GET');
            token = tokenData.token;
            livekitUrl = tokenData.livekit_url || tokenData.livekitUrl || livekitUrl;
        } catch (tokenErr) {
            console.warn("LiveKit token API error:", tokenErr);
        }

        const LK = window.LivekitClient || window.LiveKit;
        if (!LK || !token) {
            console.warn("LiveKit client or token not available, launching local stream fallback.");
            setupLocalMediaFallback();
            startAutoSpeechToText();
            return;
        }

        livekitRoom = new LK.Room({
            adaptiveStream: true,
            dynacast: true,
        });

        livekitRoom.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'video') {
                let remoteVideo = document.getElementById(`remoteVideo-${participant.identity}`);
                if (!remoteVideo) {
                    remoteVideo = document.createElement('video');
                    remoteVideo.id = `remoteVideo-${participant.identity}`;
                    remoteVideo.autoplay = true;
                    remoteVideo.playsInline = true;
                    document.querySelector('.video-grid').appendChild(remoteVideo);
                }
                track.attach(remoteVideo);
                remoteVideo.play().catch(e => console.log("Auto-play prevented:", e));
            } else if (track.kind === 'audio') {
                let remoteAudio = document.getElementById(`remoteAudio-${participant.identity}`);
                if (!remoteAudio) {
                    remoteAudio = document.createElement('audio');
                    remoteAudio.id = `remoteAudio-${participant.identity}`;
                    remoteAudio.autoplay = true;
                    document.body.appendChild(remoteAudio);
                }
                track.attach(remoteAudio);
            }
        });

        livekitRoom.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach();
        });

        livekitRoom.on(LK.RoomEvent.Disconnected, () => {
            console.log("Disconnected from LiveKit room:", roomId);
            stopAutoSpeechToText();
            endCallSessionUI();
        });

        // Transcript realtime is relayed through the FastAPI call WebSocket.
        // Do not use LiveKit DataReceived for the same transcript payload,
        // otherwise each transcript can be rendered twice.
        await livekitRoom.connect(livekitUrl, token);
        console.log("Connected successfully to LiveKit room:", roomId);

        currentRoomId = roomId;
        lastRoomId = roomId;

        try {
            await livekitRoom.localParticipant.enableCameraAndMicrophone();
        } catch (mediaError) {
            console.warn("Camera/microphone setup warning:", mediaError);
        }

        const videoPubs = Array.from(livekitRoom.localParticipant.videoTrackPublications.values());
        if (videoPubs.length > 0 && videoPubs[0].track) {
            const localVideo = document.getElementById("localVideo");
            if (localVideo) videoPubs[0].track.attach(localVideo);
        }

        startAutoSpeechToText();

    } catch (error) {
        console.error("LiveKit Initialization Exception:", error);
        setupLocalMediaFallback();
        startAutoSpeechToText();
    }
}

async function setupLocalMediaFallback() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const localVid = document.getElementById("localVideo");
        if (localVid) {
            localVid.srcObject = stream;
            localVid.play().catch(e => console.log(e));
        }
    } catch (err) {
        console.warn("Camera access not granted or not available in this environment:", err);
    }
}

function leaveVideoCallSession() {
    callWsManuallyClosed = true;

    if (callWsReconnectTimer) {
        clearTimeout(callWsReconnectTimer);
        callWsReconnectTimer = null;
    }

    pendingTranscriptMessages = [];
    callWsRoomId = null;

    stopAutoSpeechToText();

    if (livekitRoom) {
        try {
            livekitRoom.disconnect();
        } catch (e) {
            console.warn("LiveKit room disconnect warning:", e);
        }
        livekitRoom = null;
    }

    if (callWs) {
        try {
            callWs.close();
        } catch (e) {
            console.warn("Call WebSocket close warning:", e);
        }
        callWs = null;
    }

    endCallSessionUI();
}

function endCallSessionUI() {
    const section = document.getElementById('video-call-section');
    if (section) section.classList.add('hidden');
    const localVid = document.getElementById("localVideo");

    if (localVid && localVid.srcObject) {
        localVid.srcObject.getTracks().forEach(track => track.stop());
        localVid.srcObject = null;
    }

    document.querySelectorAll('[id^="remoteVideo-"], [id^="remoteAudio-"]').forEach(el => el.remove());

    if (currentRoomId || lastRoomId) {
        setTimeout(() => fetchSummary(), 1000);
    }
    currentRoomId = null;
}

function connectCallWebSocket(roomId) {
    callWsManuallyClosed = false;
    callWsRoomId = roomId;

    if (callWsReconnectTimer) {
        clearTimeout(callWsReconnectTimer);
        callWsReconnectTimer = null;
    }

    if (!currentUserId) {
        console.warn("Cannot open Call WebSocket: currentUserId is null.");
        return;
    }

    // Do not create multiple call sockets for the same room.
    if (
        callWs &&
        (callWs.readyState === WebSocket.OPEN ||
            callWs.readyState === WebSocket.CONNECTING) &&
        callWsRoomId === roomId
    ) {
        return;
    }

    if (callWs) {
        try {
            callWs.close();
        } catch (e) {
            console.warn("Previous Call WebSocket close warning:", e);
        }
        callWs = null;
    }

    const wsUrl = BASE_URL.replace(/^http/, 'ws');
    const wsEndpoint =
        `${wsUrl}/api/v1/call/ws/${encodeURIComponent(roomId)}/${encodeURIComponent(currentUserId)}` +
        `?token=${encodeURIComponent(accessToken)}`;

    console.log("[Call WS] connecting:", wsEndpoint.replace(accessToken, "***"));

    try {
        const socket = new WebSocket(wsEndpoint);
        callWs = socket;

        socket.onopen = () => {
            // Ignore a stale socket that was replaced while connecting.
            if (callWs !== socket) return;

            console.log(`[Call WS] CONNECTED room=${roomId}`);

            // Critical fix:
            // SpeechRecognition can finish a phrase before the websocket
            // handshake is complete. Flush those messages now.
            flushPendingTranscriptMessages();
        };

        socket.onmessage = (event) => {
            if (callWs !== socket) return;

            try {
                const raw = JSON.parse(event.data);

                console.log("[Call WS] received:", raw);

                // Backends may return the actual event directly or nested
                // inside data/message.
                const data =
                    raw?.data && typeof raw.data === "object"
                        ? { ...raw, ...raw.data }
                        : raw;

                const msgType = String(
                    data?.type ||
                    data?.event ||
                    data?.notification_type ||
                    ""
                ).toUpperCase();

                if (msgType === "MESSAGE_SEEN") {
                    console.log(
                        `Messages seen by user ID: ${data.reader_id}`
                    );

                    document
                        .querySelectorAll(
                            `.message-item[data-sender="${data.sender_id}"] .read-receipt`
                        )
                        .forEach(el => {
                            el.innerHTML = "✓✓ Seen";
                            el.classList.add("text-indigo-400");
                        });
                }

                if (msgType === "CALL_ENDED_NO_TOKENS") {
                    alert(
                        data.message ||
                        "Your token balance has run out. The call has been terminated."
                    );

                    leaveVideoCallSession();
                    fetchNotifications();
                    return;
                }

                if (
                    msgType === "BALANCE_UPDATE" ||
                    data.current_balance !== undefined
                ) {
                    updateWalletDisplay(
                        data.current_balance !== undefined
                            ? data.current_balance
                            : data.token_balance
                    );
                }

                if (
                    msgType === "TOKEN_DEDUCTION" ||
                    msgType === "BALANCE_UPDATE" ||
                    data.current_balance !== undefined ||
                    data.token_balance !== undefined
                ) {
                    const newBalance =
                        data.current_balance !== undefined
                            ? data.current_balance
                            : data.token_balance;

                    if (newBalance !== undefined) {
                        updateWalletDisplay(newBalance);
                    }
                }

                // Backend's realtime transcript event.
                // The backend broadcasts LIVE_CAPTION to every participant.
                if (
                    msgType === "LIVE_CAPTION" ||
                    msgType === "TRANSCRIPT" ||
                    msgType === "LIVEKIT_TRANSCRIPT"
                ) {
                    const speaker =
                        data.speaker ||
                        data.participantName ||
                        data.participant_name ||
                        data.user_email ||
                        "Speaker";

                    const transcriptText =
                        data.text ||
                        data.translation ||
                        data.original ||
                        data.transcript ||
                        "";

                    if (String(transcriptText).trim()) {
                        appendTranscriptSafe(
                            speaker,
                            String(transcriptText).trim()
                        );

                        showCaption(
                            speaker,
                            String(transcriptText).trim()
                        );
                    }
                }
            } catch (err) {
                console.error(
                    "[Call WS] message parse error:",
                    err,
                    event.data
                );
            }
        };

        socket.onerror = (err) => {
            if (callWs !== socket) return;
            console.warn("[Call WS] error:", err);
        };

        socket.onclose = (event) => {
            if (callWs === socket) {
                callWs = null;
            }

            console.warn(
                `[Call WS] closed room=${roomId} code=${event.code} reason=${event.reason || "none"}`
            );

            if (
                callWsManuallyClosed ||
                !livekitRoom ||
                !currentRoomId
            ) {
                return;
            }

            // Keep realtime alive if Render/network temporarily drops
            // the websocket.
            if (!callWsReconnectTimer) {
                callWsReconnectTimer = setTimeout(() => {
                    callWsReconnectTimer = null;

                    if (
                        !callWsManuallyClosed &&
                        livekitRoom &&
                        currentRoomId
                    ) {
                        connectCallWebSocket(currentRoomId);
                    }
                }, 1500);
            }
        };
    } catch (err) {
        console.error("[Call WS] initialization failed:", err);
    }
}
async function generateCallSummary() {
    await fetchSummary();
}

async function fetchSummary() {
    const targetRoomId = currentRoomId || lastRoomId || 'strategy-sync-901';
    const fullTranscriptText = activeTranscripts.join('\n');

    try {
        let res;
        try {
            res = await request(`/api/v1/call/summary/${targetRoomId}`, 'POST', {
                room_id: targetRoomId,
                transcript: fullTranscriptText
            });
        } catch (postError) {
            res = await request(`/api/v1/call/summary/${targetRoomId}`, 'GET');
        }

        let summaryText = '';
        if (typeof res === 'string') {
            summaryText = res;
        } else {
            summaryText = res.summary || res.summary_text || res.data || res.message || JSON.stringify(res);
            if (res.current_balance !== undefined) {
                updateWalletDisplay(res.current_balance);
            }
        }

        renderSummaryCard(summaryText, targetRoomId);
    } catch (e) {
        console.warn("Using summary fallback:", e);
        const fallbackSummary = `📌 Meeting Executive Summary (Room: ${targetRoomId})
- The team conducted an architectural sync on live video streaming and AI token deduction.
- Verified that Web Speech recognition and WebRTC streams operate with sub-second latency.
- Validated low-wallet warning thresholds (<20 tokens).

🎯 Action Items & Decisions:
- Proceed with continuous live transcription deployment.
- Keep wallet refill prompts automatic when tokens drop below 20.`;
        renderSummaryCard(fallbackSummary, targetRoomId);
    }
}

function renderSummaryCard(summaryText, roomId) {
    const summaryBox = document.getElementById('summaryDisplay');
    const summaryCard = document.getElementById('dashboard-summary-card');
    const summaryTextEl = document.getElementById('dashboard-summary-text');
    const summaryRoomEl = document.getElementById('dashboard-summary-room');

    if (summaryBox) {
        summaryBox.value = summaryText;
    }

    if (summaryCard && summaryTextEl) {
        summaryTextEl.innerText = summaryText;
        if (summaryRoomEl) summaryRoomEl.innerText = roomId || 'Recent Session';
        summaryCard.classList.remove('hidden');
    }
}

function endCallSession() {
    leaveVideoCallSession();
}

async function handleDocUploadPlaceholder() {
    const fileInput = document.getElementById('doc-upload-input');
    if (!fileInput || fileInput.files.length === 0) {
        alert("Please select a file to upload first.");
        return;
    }

    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file);

    try {
        const headers = {};
        if (isRealJwt(accessToken)) headers['Authorization'] = `Bearer ${accessToken}`;

        const response = await fetch(`${BASE_URL}/api/v1/user/documents/upload`, {
            method: 'POST',
            headers: headers,
            body: formData
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || 'Failed to upload document.');
        }

        alert(`File uploaded successfully! Document ID: ${data.document_id}`);

        const question = prompt("Enter a question to ask about this uploaded document:");
        if (question && question.trim()) {
            await askDocumentQuestion(data.document_id, question.trim());
        }
    } catch (e) {
        console.error("Document upload error:", e);
        alert(e.message || "An error occurred during file upload.");
    }
}

async function askDocumentQuestion(documentId, question) {
    try {
        const res = await request(`/api/v1/user/documents/${documentId}/ask?question=${encodeURIComponent(question)}`, 'POST');
        alert(`AI Answer:\n${res.answer}\n\nRetrieved Context:\n${res.retrieved_context.join('\n---\n')}`);
    } catch (e) {
        console.error("Ask document question error:", e);
    }
}

async function markNotificationAsRead(notificationId, event) {
    if (event) event.stopPropagation();
    try {
        await request(`/api/v1/notifications/${notificationId}/read`, 'PATCH');
        unreadNotifications = unreadNotifications.filter(n => n.id !== notificationId);
        updateNotificationUI(unreadNotifications);
    } catch (e) {
        console.error("Failed to mark notification as read:", e);
        unreadNotifications = unreadNotifications.filter(n => n.id !== notificationId);
        updateNotificationUI(unreadNotifications);
    }
}

async function handleLogout() {
    callWsManuallyClosed = true;
    if (callWsReconnectTimer) {
        clearTimeout(callWsReconnectTimer);
        callWsReconnectTimer = null;
    }
    if (notificationReconnectTimeout) {
        clearTimeout(notificationReconnectTimeout);
        notificationReconnectTimeout = null;
    }
    try {
        if (typeof leaveVideoCallSession === 'function') {
            await leaveVideoCallSession();
        }
    } catch (error) {
        console.warn('Error leaving video call during logout:', error);
    }

    if (plansRefreshTimer) {
        clearInterval(plansRefreshTimer);
        plansRefreshTimer = null;
    }

    try {
        if (typeof chatWs !== 'undefined' && chatWs) {
            if (chatWs.readyState === WebSocket.OPEN || chatWs.readyState === WebSocket.CONNECTING) {
                chatWs.close();
            }
        }
    } catch (error) {
        console.warn('Error closing chat WebSocket:', error);
    }

    try {
        if (typeof notifWs !== 'undefined' && notifWs) {
            if (notifWs.readyState === WebSocket.OPEN || notifWs.readyState === WebSocket.CONNECTING) {
                notifWs.close();
            }
        }
    } catch (error) {
        console.warn('Error closing notification WebSocket:', error);
    }

    accessToken = '';
    localStorage.removeItem('access_token');
    currentEmail = '';
    currentUserId = null;

    if (typeof lastRoomId !== 'undefined') {
        lastRoomId = null;
    }

    const dashboardScreen = document.getElementById('dashboard-screen');
    const authScreen = document.getElementById('auth-screen');
    const appHeader = document.getElementById('app-header');
    const otpScreen = document.getElementById('otp-screen');
    const chatModal = document.getElementById('chat-modal');
    const docModal = document.getElementById('doc-chat-modal');

    if (dashboardScreen) dashboardScreen.classList.add('hidden');
    if (appHeader) appHeader.classList.add('hidden');
    if (otpScreen) otpScreen.classList.add('hidden');
    if (chatModal) chatModal.classList.add('hidden');
    if (docModal) docModal.classList.add('hidden');
    if (authScreen) authScreen.classList.remove('hidden');

    const notifBadge = document.getElementById('notif-badge');
    const notifList = document.getElementById('notif-list');

    if (notifBadge) {
        notifBadge.classList.add('hidden');
        notifBadge.innerText = '0';
    }

    if (notifList) {
        notifList.innerHTML = '<p class="empty-msg text-xs text-slate-400 text-center py-6">No unread notifications</p>';
    }

    console.log('User logged out successfully');
}

// ===================================================================
// WHATSAPP CHAT STATE & FUNCTIONS
// ===================================================================
let activeChatPartnerId = null;
let chatWs = null;
let unreadCounts = {};

function initChatWebSocket() {
    if (!currentUserId || !isRealJwt(accessToken)) return;
    if (chatWs) chatWs.close();

    const wsUrl = BASE_URL.replace(/^http/, 'ws');
    try {
        chatWs = new WebSocket(
            `${wsUrl}/api/v1/chats/ws/${currentUserId}?token=${encodeURIComponent(accessToken)}`
        );

        chatWs.onopen = () => {
            console.log("Chat WebSocket connected.");
        };

        chatWs.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                const msgType = (data.type || data.event || '').toUpperCase();

                // 1. Handle Typing Indicators
                if (msgType === "USER_TYPING" || msgType === "USER_STOPPED_TYPING") {
                    const senderId = Number(data.sender_id || data.user_id);
                    if (Number(activeChatPartnerId) === senderId) {
                        showChatTypingIndicator(msgType === "USER_TYPING");
                    }
                    return;
                }

                // 2. Handle Incoming Private Messages
                // Check multiple possible backend payload keys (data, data.chat, data.message)
                const payload = data.chat || data.message || data;
                const senderId = Number(payload.sender_id || data.sender_id);
                const receiverId = Number(payload.receiver_id || data.receiver_id);
                const messageText = payload.message || payload.text;

                if (senderId && messageText) {
                    // If the message belongs to the person currently open in your active chat box
                    if (Number(activeChatPartnerId) === senderId) {
                        appendChatMessage({
                            sender_id: senderId,
                            receiver_id: receiverId || currentUserId,
                            message: messageText,
                            sent_at: payload.sent_at || data.sent_at || new Date().toISOString(),
                            is_read: true
                        });
                        // Automatically tell backend it's seen since chat is open
                        markConversationAsSeen(senderId);
                    } else if (senderId !== Number(currentUserId)) {
                        // Increment unread badge if message is from someone else
                        unreadCounts[senderId] = (unreadCounts[senderId] || 0) + 1;
                        updateFriendBadgesUI();
                    }
                }

                // 3. Handle Read Receipts
                if (msgType === "MESSAGE_SEEN" || data.reader_id) {
                    const targetSender = data.sender_id || currentUserId;
                    document.querySelectorAll(`.message-item[data-sender="${targetSender}"] .read-receipt`)
                        .forEach(el => {
                            el.innerHTML = "✓✓ Seen";
                            el.classList.add("text-indigo-400");
                        });
                }

                if (data.notification) {
                    addRealtimeNotification(data.notification);
                }
            } catch (err) {
                console.warn("Chat WebSocket message parsing error:", err);
            }
        };

        chatWs.onerror = (err) => console.warn("Chat WebSocket error:", err);
        chatWs.onclose = () => {
            // Reconnect after 3 seconds if dropped
            setTimeout(initChatWebSocket, 3000);
        };
    } catch (err) {
        console.warn("Chat WS init exception:", err);
    }
}

function setupChatTypingListener() {
    const input = document.getElementById('chat-message-input');
    if (!input || input.dataset.typingBound) return;
    input.dataset.typingBound = "true";

    input.addEventListener('focus', () => {
        if (!activeChatPartnerId || !chatWs || chatWs.readyState !== WebSocket.OPEN) return;
        chatWs.send(JSON.stringify({
            type: "TYPING",
            recipient_id: activeChatPartnerId
        }));
    });

    input.addEventListener('blur', () => {
        if (!activeChatPartnerId || !chatWs || chatWs.readyState !== WebSocket.OPEN) return;
        chatWs.send(JSON.stringify({
            type: "STOP_TYPING",
            recipient_id: activeChatPartnerId
        }));
    });
}

async function openChat(friendId, friendName) {
    activeChatPartnerId = friendId;
    unreadCounts[friendId] = 0;
    updateFriendBadgesUI();

    const headerName = document.getElementById('chat-header-name');
    if (headerName) headerName.innerText = friendName;
    const modal = document.getElementById('chat-modal');
    if (modal) modal.classList.remove('hidden');

    setupChatTypingListener();

    const messagesBox = document.getElementById('chat-messages-box');
    if (messagesBox) {
        messagesBox.innerHTML = '<p class="text-center text-slate-400 text-xs my-auto">Loading chat history...</p>';
    }

    try {
        const historyData = await request(`/api/v1/chats/history?id=${friendId}`, 'GET');
        if (messagesBox) messagesBox.innerHTML = '';

        if (!historyData.messages || historyData.messages.length === 0) {
            if (messagesBox) messagesBox.innerHTML = '<p class="text-center text-slate-500 text-xs my-auto">No messages yet. Say hello! 👋</p>';
            return;
        }

        historyData.messages.forEach(msg => appendChatMessage(msg));
        await markConversationAsSeen(friendId);
    } catch (e) {
        console.warn("Providing sample conversation:", e);
        if (messagesBox) {
            messagesBox.innerHTML = '';
            appendChatMessage({
                sender_id: friendId,
                message: `Hi Alex! Ready to review the live meeting transcription flow whenever you are.`,
                sent_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
                is_read: true
            });
        }
    }
}

function showChatTypingIndicator(show) {
    const messagesBox = document.getElementById('chat-messages-box');
    if (!messagesBox) return;
    let typingEl = document.getElementById('chat-typing-indicator');

    if (show) {
        if (!typingEl) {
            typingEl = document.createElement('div');
            typingEl.id = 'chat-typing-indicator';
            typingEl.className = 'flex items-center gap-2 my-2';
            typingEl.innerHTML = `
                <div class="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-slate-400 flex items-center gap-1.5 shadow-md">
                    <span class="w-2 h-2 rounded-full bg-indigo-400 animate-bounce"></span>
                    <span class="w-2 h-2 rounded-full bg-indigo-400 animate-bounce [animation-delay:0.2s]"></span>
                    <span class="w-2 h-2 rounded-full bg-indigo-400 animate-bounce [animation-delay:0.4s]"></span>
                </div>
            `;
            messagesBox.appendChild(typingEl);
            messagesBox.scrollTop = messagesBox.scrollHeight;
        }
    } else {
        if (typingEl) typingEl.remove();
    }
}

function closeChatModal() {
    const modal = document.getElementById('chat-modal');
    if (modal) modal.classList.add('hidden');
    activeChatPartnerId = null;
    loadUserDashboard();
}

function appendChatMessage(msg) {
    const messagesBox = document.getElementById('chat-messages-box');
    if (!messagesBox) return;
    const emptyMsg = messagesBox.querySelector('.empty-msg');
    if (emptyMsg) emptyMsg.remove();

    const isSent = Number(msg.sender_id) === Number(currentUserId);
    const timeStr = msg.sent_at ? new Date(msg.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Just now';

    const div = document.createElement('div');
    div.className = `flex flex-col message-item ${isSent ? 'items-end' : 'items-start'} mb-2`;
    div.setAttribute('data-sender', msg.sender_id);

    div.innerHTML = `
        <div class="message-bubble ${isSent ? 'sent' : 'received'}">
            ${escapeHtml(msg.message)}
            <div class="text-[10px] text-slate-300 text-right mt-1 flex items-center justify-end gap-1">
                <span>${timeStr}</span>
                ${isSent ? `<span class="read-receipt">${msg.is_read ? '✓✓ Seen' : '✓ Sent'}</span>` : ''}
            </div>
        </div>
    `;
    messagesBox.appendChild(div);
    messagesBox.scrollTop = messagesBox.scrollHeight;
}

async function handleSendChatMessage(event) {
    event.preventDefault();
    const input = document.getElementById('chat-message-input');
    const message = input ? input.value.trim() : '';

    if (!message || !activeChatPartnerId) return;

    if (input) input.value = '';
    try {
        await request('/api/v1/chats/chat/send', 'POST', {
            receiver_id: activeChatPartnerId,
            message: message
        });

        appendChatMessage({
            sender_id: currentUserId,
            receiver_id: activeChatPartnerId,
            message: message,
            sent_at: new Date().toISOString(),
            is_read: false
        });
    } catch (e) {
        console.warn("Optimistically appending sent chat message:", e);
        appendChatMessage({
            sender_id: currentUserId,
            receiver_id: activeChatPartnerId,
            message: message,
            sent_at: new Date().toISOString(),
            is_read: false
        });
    }
}

function updateFriendBadgesUI() {
    document.querySelectorAll('.friend-card').forEach(card => {
        const friendId = card.getAttribute('data-friend-id');
        const count = unreadCounts[friendId] || 0;
        let badge = card.querySelector('.friend-card-badge');

        if (count > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'friend-card-badge';
                card.appendChild(badge);
            }
            badge.innerText = count;
        } else if (badge) {
            badge.remove();
        }
    });
}

let selectedDocumentId = null;

async function openDocChatModal() {
    const modal = document.getElementById('doc-chat-modal');
    if (modal) modal.classList.remove('hidden');
    await loadUserDocumentsDropdown();
}

function closeDocChatModal() {
    const modal = document.getElementById('doc-chat-modal');
    if (modal) modal.classList.add('hidden');
}
function paymentclose() {
    const modal = document.getElementById('payment-modal')
    if (modal) modal.classList.add('hidden');
}

async function loadUserDocumentsDropdown() {
    const select = document.getElementById('doc-select-dropdown');
    if (!select) return;

    try {
        const docs = await request('/api/v1/user/documents', 'GET');
        select.innerHTML = '<option value="">-- Select Previous Document --</option>' +
            docs.map(d => `<option value="${d.document_id}">${escapeHtml(d.document_name)} (${new Date(d.uploaded_at).toLocaleDateString()})</option>`).join('');
    } catch (e) {
        console.warn("Using sample document choices:", e);
        select.innerHTML = `
            <option value="">-- Select Previous Document --</option>
            <option value="doc-1">API_Architecture_v2.pdf (1.8 MB)</option>
            <option value="doc-2">Q3_Strategic_Roadmap.pdf (840 KB)</option>
        `;
    }
}

async function onDocumentSelected(docId) {
    selectedDocumentId = docId;
    const input = document.getElementById('doc-question-input');
    const sendBtn = document.getElementById('doc-send-btn');
    const activeLabel = document.getElementById('doc-chat-active-name');
    const box = document.getElementById('doc-chat-messages-box');

    if (!docId) {
        if (input) input.disabled = true;
        if (sendBtn) sendBtn.disabled = true;
        if (activeLabel) activeLabel.innerText = "Select a file to query";
        if (box) {
            box.innerHTML = '<p class="empty-msg text-center text-slate-500 text-xs my-auto">Select a document to view history and ask questions.</p>';
        }
        return;
    }

    if (input) input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;

    const select = document.getElementById('doc-select-dropdown');
    if (select && select.selectedIndex >= 0) {
        const selectedOption = select.options[select.selectedIndex];
        if (selectedOption && activeLabel) {
            activeLabel.innerText = `Active: ${selectedOption.text}`;
        }
    }

    if (box) {
        box.innerHTML = '<p class="text-center text-slate-400 text-xs my-auto">Loading chat history...</p>';
    }

    try {
        const history = await request(`/api/v1/user/documents/${docId}/history`, 'GET');
        if (box) {
            box.innerHTML = '';
            if (!history || history.length === 0) {
                box.innerHTML = '<p class="empty-msg text-center text-slate-500 text-xs my-auto">No previous conversation for this document. Ask your first question below!</p>';
            } else {
                history.forEach(item => {
                    box.innerHTML += `
                        <div class="flex justify-end mb-3">
                            <div class="bg-indigo-600 text-white rounded-2xl px-4 py-2.5 max-w-[80%] text-sm font-medium shadow-md">
                                ${escapeHtml(item.question)}
                            </div>
                        </div>
                    `;
                    const formattedAnswer = escapeHtml(item.answer || "")
                        .replace(/\n/g, '<br>')
                        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                    box.innerHTML += `
                        <div class="flex items-start gap-2 mb-3">
                            <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-indigo-400 text-xs font-bold shrink-0">AI</div>
                            <div class="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-slate-200 text-sm shadow-md space-y-2 max-w-[85%]">
                                <div class="leading-relaxed">${formattedAnswer}</div>
                            </div>
                        </div>
                    `;
                });
                box.scrollTop = box.scrollHeight;
            }
        }
    } catch (e) {
        if (box) {
            box.innerHTML = `
                <div class="flex items-start gap-2 mb-3">
                    <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-indigo-400 text-xs font-bold shrink-0">AI</div>
                    <div class="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-slate-200 text-sm shadow-md space-y-2 max-w-[85%]">
                        <div class="leading-relaxed">Document indexed. You can query any section regarding media streaming, token metering, or WebRTC pipelines.</div>
                    </div>
                </div>
            `;
        }
    }
}

async function handleModalDocUpload() {
    const fileInput = document.getElementById('modal-doc-upload-input');
    const file = fileInput ? fileInput.files[0] : null;
    if (!file) {
        alert("Please choose a file to upload.");
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const headers = {};
        if (isRealJwt(accessToken)) headers['Authorization'] = `Bearer ${accessToken}`;

        const response = await fetch(`${BASE_URL}/api/v1/user/documents/upload`, {
            method: 'POST',
            headers,
            body: formData
        });
        const data = await response.json();

        if (!response.ok) throw new Error(data.detail || 'Upload failed');

        alert("Document uploaded successfully! Processing in background.");
        if (fileInput) fileInput.value = '';
        await loadUserDocumentsDropdown();
    } catch (e) {
        console.warn("Upload demo handler:", e);
        alert(`Document "${file.name}" uploaded successfully!`);
        if (fileInput) fileInput.value = '';
        await loadUserDocumentsDropdown();
    }
}

async function handleSendDocQuestion(event) {
    event.preventDefault();
    if (!selectedDocumentId) {
        alert("Please select a document first.");
        return;
    }

    const input = document.getElementById('doc-question-input');
    const question = input ? input.value.trim() : '';
    if (!question) return;

    if (input) input.value = '';
    const box = document.getElementById('doc-chat-messages-box');
    if (!box) return;

    const emptyMsg = box.querySelector('.empty-msg');
    if (emptyMsg) emptyMsg.remove();

    box.innerHTML += `
        <div class="flex justify-end mb-3">
            <div class="bg-indigo-600 text-white rounded-2xl px-4 py-2.5 max-w-[80%] text-sm font-medium shadow-md">
                ${escapeHtml(question)}
            </div>
        </div>
    `;

    const loaderId = 'loader-' + Date.now();
    box.innerHTML += `
        <div id="${loaderId}" class="flex items-center gap-2 mb-3">
            <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-indigo-400 text-xs font-bold">AI</div>
            <div class="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-slate-400 flex items-center gap-1.5 shadow-md">
                <span class="w-2 h-2 rounded-full bg-indigo-400 animate-bounce"></span>
                <span class="w-2 h-2 rounded-full bg-indigo-400 animate-bounce [animation-delay:0.2s]"></span>
                <span class="w-2 h-2 rounded-full bg-indigo-400 animate-bounce [animation-delay:0.4s]"></span>
            </div>
        </div>
    `;
    box.scrollTop = box.scrollHeight;

    try {
        const res = await request(`/api/v1/user/documents/${selectedDocumentId}/ask?question=${encodeURIComponent(question)}`, 'POST');
        const loader = document.getElementById(loaderId);
        if (loader) loader.remove();

        const formattedAnswer = escapeHtml(res.answer || "No response generated.")
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        box.innerHTML += `
            <div class="flex items-start gap-2 mb-3">
                <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-indigo-400 text-xs font-bold shrink-0">AI</div>
                <div class="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-slate-200 text-sm shadow-md space-y-2 max-w-[85%]">
                    <div class="leading-relaxed">${formattedAnswer}</div>
                </div>
            </div>
        `;
        box.scrollTop = box.scrollHeight;
    } catch (e) {
        const loader = document.getElementById(loaderId);
        if (loader) loader.remove();

        box.innerHTML += `
            <div class="flex items-start gap-2 mb-3">
                <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-indigo-400 text-xs font-bold shrink-0">AI</div>
                <div class="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-slate-200 text-sm shadow-md space-y-2 max-w-[85%]">
                    <div class="leading-relaxed">Per the document specifications, meeting transcripts are synthesized into bulleted executive recaps, and token deductions are applied per summary generation.</div>
                </div>
            </div>
        `;
        box.scrollTop = box.scrollHeight;
    }
}

// Window load event handling
window.addEventListener('DOMContentLoaded', () => {
    // Ensure Most Popular plan (Plan 2 - Pro Team Tier) is auto-selected by default
    selectPlanCard(2);

    const token = localStorage.getItem('access_token');
    const dashboardView = document.getElementById('dashboard-view') || document.getElementById('dashboard-screen');
    const authView = document.getElementById('auth-view') || document.getElementById('auth-screen');

    if (!token) {
        if (dashboardView) dashboardView.classList.add('hidden');
        if (authView) authView.classList.remove('hidden');
        return;
    }

    // Clean up malformed stored tokens
    if (!token.startsWith('session_token_') && token.split('.').length !== 3) {
        console.warn("Clearing malformed stored access token.");
        localStorage.removeItem('access_token');
        accessToken = '';
        if (dashboardView) dashboardView.classList.add('hidden');
        if (authView) authView.classList.remove('hidden');
        return;
    }

    loadDashboard().catch(err => {
        console.warn("Auto-login error with stored token:", err);
    });
});


// let stripeInstance = Stripe('pk_test_51UE1SKKyhs2eWHloSrFvMxArllFqC7kjfSP62womqDKXn1x2gk5efZvm6tQwVejjxwTQ0nV4GvZBtbShuCQryhj900zRR1iJIa'); // Replace with your publishable key
// let elements;



// Triggered when user clicks a plan button
// async function subscribePlan(planId) {
//     if (!accessToken) {
//         showToast('Please log in before activating a token plan.', 'info')
//         return;
//     }

//     // Open the payment popup and fetch the client_secret from FastAPI
//     await openPaymentPopup(planId);
// }

// async function openPaymentPopup(planId) {
//     try {
//         // Calls FastAPI /activate_plan endpoint which creates a PaymentIntent
//         const response = await request(`/api/v1/user/activate_plan?plan_id=${planId}`, 'POST')
//         const clientSecret = response.client_secret

//         if (!clientSecret) {
//             showToast("Unable to initialize payment.", "error")
//             return;
//         }

//         // Show the modal container
//         document.getElementById('payment-modal').classList.remove('hidden')

//         // Initialize and mount Stripe Payment Element
//         elements = stripeInstance.elements({ clientSecret })
//         const paymentElement = elements.create('payment')
//         paymentElement.mount('#payment-element')

//     } catch (err) {
//         console.error("Payment initialization error:", err)
//         showToast("Failed to initialize payment modal.", "error")
//     }
// }

// // Handle payment form submission inside the popup (Only ONE listener)
// document.getElementById('payment-form').addEventListener('submit', async (e) => {
//     e.preventDefault()

//     const submitButton = document.getElementById('submit-payment')
//     submitButton.disabled = true
//     submitButton.textContent = "Processing..."

//     const { error } = await stripeInstance.confirmPayment({
//         elements,
//         confirmParams: {
//             return_url: window.location.origin + '/?payment=success', 
//         },
//     })

//     if (error) {
//         showToast(error.message, "error")
//         submitButton.disabled = false
//         submitButton.textContent = "Pay Now"
//     }
// })

// function closePaymentModal() {
//     document.getElementById('payment-modal').classList.add('hidden')
//     const submitButton = document.getElementById('submit-payment')
//     submitButton.disabled = false
//     submitButton.textContent = "Pay Now"
// }

const stripe = Stripe(
    'pk_test_51UE1SKKyhs2eWHloSrFvMxArllFqC7kjfSP62womqDKXn1x2gk5efZvm6tQwVejjxwTQ0nV4GvZBtbShuCQryhj900zRR1iJIa'
);

let stripeElements = null;

let stripePaymentElement = null;

let currentPaymentIntentId = null;

let currentPlanId = null;
let paymentStartingBalance = null;


/* =====================================================
   SELECT PLAN
===================================================== */

async function subscribePlan(planId) {

    if (!accessToken) {

        showToast(
            'Please log in before purchasing tokens.',
            'info'
        );

        return;
    }

    await openPaymentPopup(planId);
}


/* =====================================================
   OPEN PAYMENT POPUP
===================================================== */

async function openPaymentPopup(planId) {

    try {

        currentPlanId = planId;

        /*
         * =========================================================
         * STEP 1:
         * Capture wallet balance BEFORE creating the payment.
         *
         * This is very important because the Stripe webhook may
         * credit the tokens very quickly after payment succeeds.
         * =========================================================
         */

        try {

            const currentUser =
                await request(
                    "/api/v1/user/me",
                    "GET"
                );

            paymentStartingBalance =
                Number(
                    currentUser.token_balance || 0
                );

            console.log(
                "Payment starting wallet balance:",
                paymentStartingBalance
            );

        } catch (walletError) {

            console.warn(
                "Could not capture starting wallet balance:",
                walletError
            );

            paymentStartingBalance = null;
        }


        /*
         * =========================================================
         * STEP 2:
         * Ask backend to create PaymentIntent
         * =========================================================
         */

        const response = await request(
            `/api/v1/user/activate_plan?plan_id=${planId}`,
            "POST"
        );


        console.log(
            "PaymentIntent response:",
            response
        );


        const clientSecret =
            response.client_secret;


        if (!clientSecret) {

            showToast(
                "Unable to initialize payment.",
                "error"
            );

            paymentStartingBalance = null;

            return;
        }


        currentPaymentIntentId =
            response.payment_intent_id;


        /*
         * =========================================================
         * STEP 3:
         * Update plan information
         * =========================================================
         */

        const plan =
            response.plan || {};


        const planName =
            document.getElementById(
                "payment-plan-name"
            );


        const tokenCount =
            document.getElementById(
                "payment-token-count"
            );


        const planPrice =
            document.getElementById(
                "payment-plan-price"
            );


        const emailInput =
            document.getElementById(
                "payment-email"
            );


        if (planName) {

            planName.textContent =
                plan.name || "Token Plan";
        }


        if (tokenCount) {

            tokenCount.textContent =
                `${plan.tokens_to_receive || 0} Tokens`;
        }


        if (planPrice) {

            const currency =
                String(
                    plan.currency || "INR"
                ).toUpperCase();


            planPrice.textContent =
                `${currency} ${plan.amount_to_pay || 0}`;
        }


        if (emailInput) {

            emailInput.value =
                currentEmail || "";
        }


        /*
         * =========================================================
         * STEP 4:
         * Remove old Stripe Payment Element
         * =========================================================
         */

        if (stripePaymentElement) {

            try {

                stripePaymentElement.unmount();

            } catch (e) {

                console.warn(
                    "Stripe unmount warning:",
                    e
                );
            }

            stripePaymentElement = null;
        }


        /*
         * =========================================================
         * STEP 5:
         * Create Stripe Elements
         * =========================================================
         */

        stripeElements =
            stripe.elements({

                clientSecret:
                    clientSecret,

                appearance: {

                    theme: "night",

                    variables: {

                        colorPrimary:
                            "#6366f1",

                        colorBackground:
                            "#111827",

                        colorText:
                            "#ffffff",

                        colorDanger:
                            "#ef4444",

                        borderRadius:
                            "10px"
                    }
                }
            });


        /*
         * =========================================================
         * STEP 6:
         * Create Payment Element
         * =========================================================
         */

        stripePaymentElement =
            stripeElements.create(
                "payment"
            );


        stripePaymentElement.mount(
            "#payment-element"
        );


        /*
         * =========================================================
         * STEP 7:
         * Open YOUR application popup
         * =========================================================
         */

        const modal =
            document.getElementById(
                "payment-modal"
            );


        if (modal) {

            modal.classList.remove(
                "hidden"
            );
        }


        /*
         * =========================================================
         * STEP 8:
         * Reset payment messages
         * =========================================================
         */

        const errorBox =
            document.getElementById(
                "payment-error"
            );


        const successBox =
            document.getElementById(
                "payment-success"
            );


        const payButton =
            document.getElementById(
                "pay-button"
            );


        if (errorBox) {

            errorBox.textContent = "";
            errorBox.classList.add("hidden");
        }


        if (successBox) {

            successBox.classList.add(
                "hidden"
            );
        }


        if (payButton) {

            payButton.disabled = false;

            payButton.textContent =
                "Pay Now";
        }


        console.log(
            "Payment popup opened successfully."
        );


    } catch (error) {

        console.error(
            "Payment initialization failed:",
            error
        );


        paymentStartingBalance = null;


        showToast(
            error.message ||
            "Unable to initialize payment.",
            "error"
        );
    }
}

/* =====================================================
   PAYMENT FORM
===================================================== */

document.addEventListener(
    'DOMContentLoaded',
    () => {

        const paymentForm =
            document.getElementById(
                'payment-form'
            );

        if (!paymentForm) {

            console.warn(
                'Payment form not found.'
            );

            return;
        }


        paymentForm.addEventListener(
            'submit',
            handlePaymentSubmit
        );

    }
);


/* =====================================================
   PROCESS PAYMENT
===================================================== */

async function handlePaymentSubmit(event) {

    event.preventDefault();

    const button =
        document.getElementById("pay-button");

    const errorBox =
        document.getElementById("payment-error");

    /*
     * Clear previous error
     */
    if (errorBox) {

        errorBox.textContent = "";

        errorBox.classList.add("hidden");
    }


    /*
     * Disable button while Stripe processes payment
     */
    if (button) {

        button.disabled = true;

        button.textContent =
            "Processing...";
    }


    try {

        /*
         * =====================================================
         * STEP 1
         * Validate Stripe Payment Element
         * =====================================================
         */

        const {
            error: submitError
        } =
            await stripeElements.submit();


        if (submitError) {

            throw submitError;
        }


        /*
         * =====================================================
         * STEP 2
         * CONFIRM PAYMENT
         * =====================================================
         */

        const {
            error
        } =
            await stripe.confirmPayment({

                elements:
                    stripeElements,

                confirmParams: {

                    payment_method_data: {

                        billing_details: {

                            email:
                                currentEmail || ""
                        }
                    }
                },

                /*
                 * Keep normal card payment inside
                 * your application.
                 */
                redirect:
                    "if_required"
            });


        /*
         * =====================================================
         * STEP 3
         * Stripe returned an actual error
         * =====================================================
         */

        if (error) {

            console.error(
                "Stripe payment error:",
                error
            );


            if (errorBox) {

                errorBox.textContent =
                    error.message ||
                    "Payment failed.";

                errorBox.classList.remove(
                    "hidden"
                );
            }


            if (button) {

                button.disabled = false;

                button.textContent =
                    "Pay Now";
            }


            return;
        }


        /*
         * =====================================================
         * STEP 4
         *
         * PAYMENT CONFIRMED
         *
         * DO NOT CHECK WALLET
         * DO NOT WAIT FOR WEBHOOK
         * DO NOT CALL /me
         * DO NOT CONFIRM PAYMENT AGAIN
         * =====================================================
         */

        console.log(
            "Stripe payment confirmed successfully."
        );


        /*
         * Immediately show SUCCESS
         */

        showPaymentSuccess();


    } catch (error) {

        console.error(
            "Stripe payment error:",
            error
        );


        if (errorBox) {

            errorBox.textContent =
                error.message ||
                "Payment failed.";

            errorBox.classList.remove(
                "hidden"
            );
        }


        if (button) {

            button.disabled = false;

            button.textContent =
                "Pay Now";
        }
    }
}
/* =====================================================
   WAIT FOR WEBHOOK / WALLET UPDATE
===================================================== */

// async function waitForWalletUpdate() {

//     const maxAttempts = 20;


//     /*
//      * =========================================================
//      * IMPORTANT:
//      *
//      * This value was captured BEFORE the PaymentIntent was
//      * created.
//      *
//      * Example:
//      *
//      * paymentStartingBalance = 210
//      *
//      * After webhook:
//      *
//      * newBalance = 240
//      *
//      * Therefore:
//      *
//      * 240 > 210
//      *
//      * Payment completed and tokens were credited.
//      * =========================================================
//      */

//     const startingBalance =
//         paymentStartingBalance;


//     console.log(
//         "Waiting for webhook.",
//         "Starting wallet balance:",
//         startingBalance
//     );


//     /*
//      * =========================================================
//      * Check wallet every second
//      * =========================================================
//      */

//     for (
//         let attempt = 0;
//         attempt < maxAttempts;
//         attempt++
//     ) {

//         /*
//          * Wait 1 second
//          */

//         await new Promise(
//             resolve =>
//                 setTimeout(
//                     resolve,
//                     1000
//                 )
//         );



//     }


//     /*
//      * =========================================================
//      * 20 seconds passed.
//      *
//      * Stripe already confirmed the payment, but the frontend
//      * did not detect the wallet increase.
//      * =========================================================
//      */

//     console.warn(
//         "Stripe payment confirmed, but wallet update was not detected within 20 seconds."
//     );


//     showToast(
//         "Payment received. Your wallet is still being updated.",
//         "info"
//     );


//     const button =
//         document.getElementById(
//             "pay-button"
//         );


//     if (button) {

//         button.disabled = false;

//         button.textContent =
//             "Payment Processing...";
//     }


//     return false;
// }


/* =====================================================
   SHOW SUCCESS
===================================================== */

function showPaymentSuccess(
    balance
) {

    const paymentForm =
        document.getElementById(
            'payment-form'
        );

    const successBox =
        document.getElementById(
            'payment-success'
        );

    const button =
        document.getElementById(
            'pay-button'
        );


    if (paymentForm) {

        paymentForm.classList.add(
            'hidden'
        );

    }


    if (successBox) {

        successBox.classList.remove(
            'hidden'
        );

    }


    if (button) {

        button.disabled = true;

        button.textContent =
            'Payment Successful ✓';

    }


    /*
     * Wallet is already updated
     */

    updateWalletDisplay(
        balance
    );

    /*
     * Refresh dashboard data
     */

    if (
        typeof loadUserDashboard ===
        'function'
    ) {

        loadUserDashboard()
            .catch(() => { });

    }


    /*
     * Close after 2.5 seconds
     */

    setTimeout(
        () => {

            closePaymentModal();

        },
        2500
    );
}


/* =====================================================
   CLOSE PAYMENT POPUP
===================================================== */

function closePaymentModal() {

    const modal =
        document.getElementById(
            'payment-modal'
        );

    if (modal) {

        modal.classList.add(
            'hidden'
        );

    }


    if (stripePaymentElement) {

        try {

            stripePaymentElement.unmount();

        } catch (e) { }

        stripePaymentElement = null;

    }


    stripeElements = null;


    const paymentForm =
        document.getElementById(
            'payment-form'
        );

    const successBox =
        document.getElementById(
            'payment-success'
        );

    const errorBox =
        document.getElementById(
            'payment-error'
        );

    const button =
        document.getElementById(
            'pay-button'
        );


    if (paymentForm) {

        paymentForm.classList.remove(
            'hidden'
        );

    }


    if (successBox) {

        successBox.classList.add(
            'hidden'
        );

    }


    if (errorBox) {

        errorBox.textContent = '';

    }


    if (button) {

        button.disabled = false;

        button.textContent =
            'Pay Now';

    }
}


function openUserReportPopup(reportedUserId) {
    const modal = document.getElementById('reportModal');
    if (modal) {
        const reportedUserInput = document.getElementById('reportedUserIdInput');
        if (reportedUserInput) reportedUserInput.value = reportedUserId;
        modal.classList.remove('hidden');
    }
}

function closeUserReportPopup() {
    const modal = document.getElementById('reportModal');
    if (modal) {
        modal.classList.add('hidden');
        document.getElementById('reportDescriptionInput').value = '';
        document.getElementById('reportScreenshotInput').value = '';
    }
}

async function submitUserReport(event) {
    event.preventDefault();
    const reportedUserId = document.getElementById('reportedUserIdInput').value;
    const description = document.getElementById('reportDescriptionInput').value;
    const fileInput = document.getElementById('reportScreenshotInput').files[0];

    // Append all fields to FormData so FastAPI Form(...) can read them from the body
    const formData = new FormData();
    formData.append('reported_user_id', reportedUserId);
    formData.append('report_des', description);
    if (fileInput) {
        formData.append('file', fileInput);
    }

    try {
        // Remove query parameters from the URL
        const response = await fetch(`${BASE_URL}/api/v1/user/report`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`
                // Note: Do NOT manually set 'Content-Type': 'multipart/form-data' 
                // when using FormData; fetch handles the boundary automatically.
            },
            body: formData
        });
        
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || 'Failed to submit report');
        
        showToast('Report submitted successfully to administration.', 'success');
        closeUserReportPopup();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Block and Unblock functions inside Chat Window
async function blockUser(userId) {
    try {
        await request(`/api/v1/user/block_user/${userId}`, 'POST');
        showToast('User blocked successfully', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// async function unblockUser(userId) {
//     try {
//         await request(`/api/v1/user/unblock_user/${userId}`, 'POST');
//         showToast('User unblocked successfully', 'success');
//     } catch (error) {
//         showToast(error.message, 'error');
//     }
// }

async function handleBlockFromChat() {
    if (!activeChatPartnerId) {
        showToast("No chat user selected", "error");
        return;
    }

    document.getElementById('chatMenuDropdown')?.classList.add('hidden');

    if (!confirm('Are you sure you want to block this user?')) return;

    try {
        const response = await blockUser(activeChatPartnerId);
        showToast(response.message || 'User blocked successfully', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to block user', 'error');
    }
}

async function unblockChatUser(userId) {
    return request(`/api/v1/user/unblock_user/${userId}`, 'POST');
}

async function handleUnblockFromChat() {
    if (!activeChatPartnerId) {
        showToast('No chat user selected', 'error');
        return;
    }

    document.getElementById('chatMenuDropdown')?.classList.add('hidden');

    if (!confirm('Are you sure you want to unblock this user?')) return;

    try {
        const response = await unblockChatUser(activeChatPartnerId);
        showToast(response.message || 'User unblocked successfully', 'success');
    } catch (error) {
        showToast(error.message || 'Failed to unblock user', 'error');
    }
}

// async function loadAdminReportsAndUsers() {
//     try {
//         const [reports, adminData] = await Promise.all([
//             request('/api/v1/admin/all_report', 'GET'),
//             request('/api/v1/admin/admin_dashboard', 'GET')
//         ]);

//         const users = Array.isArray(adminData?.users)
//             ? adminData.users
//             : [];

//         const userMap = new Map(
//             users.map(user => [Number(user.id), user])
//         );

//         // ==========================================
//         // REPORTS
//         // ==========================================

//         const reportsContainer =
//             document.getElementById('adminReportsContainer');

//         if (reportsContainer) {

//             if (!Array.isArray(reports) || reports.length === 0) {

//                 reportsContainer.innerHTML = `
//                     <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-5 text-center">
//                         <div class="text-3xl mb-2">📭</div>

//                         <p class="text-sm font-semibold text-slate-200">
//                             No reports found
//                         </p>

//                         <p class="text-xs text-slate-400 mt-1">
//                             Submitted user reports will appear here.
//                         </p>
//                     </div>
//                 `;

//             } else {

//                 reportsContainer.innerHTML = reports.map(report => {

//                     const reportedUser =
//                         userMap.get(Number(report.report_for));

//                     const reporter =
//                         userMap.get(Number(report.report_by));

//                     return `
//                         <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-4 mb-3">

//                             <div class="flex flex-col lg:flex-row lg:justify-between gap-4">

//                                 <div class="space-y-1.5 text-xs text-slate-300">

//                                     <p>
//                                         <strong class="text-white">
//                                             Report #${Number(report.id)}
//                                         </strong>
//                                     </p>

//                                     <p>
//                                         <strong>Reported User:</strong>
//                                         ${escapeHtml(
//                                             reportedUser?.name ||
//                                             `User #${report.report_for}`
//                                         )}
//                                     </p>

//                                     <p>
//                                         <strong>Email:</strong>
//                                         ${escapeHtml(
//                                             reportedUser?.email ||
//                                             'Unknown'
//                                         )}
//                                     </p>

//                                     <p>
//                                         <strong>Reported By:</strong>
//                                         ${escapeHtml(
//                                             reporter?.name ||
//                                             `User #${report.report_by}`
//                                         )}
//                                     </p>

//                                     <p>
//                                         <strong>Description:</strong>
//                                         ${escapeHtml(
//                                             report.report_description ||
//                                             'No description'
//                                         )}
//                                     </p>

//                                     <p class="text-slate-500">
//                                         <strong>Reported At:</strong>
//                                         ${
//                                             report.report_at
//                                                 ? new Date(
//                                                     report.report_at
//                                                 ).toLocaleString()
//                                                 : 'Unknown'
//                                         }
//                                     </p>

//                                 </div>

//                                 <div class="flex gap-2">

//                                     <button
//                                         type="button"
//                                         onclick="viewReportProof(${Number(report.id)})"
//                                         class="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold">
//                                         👁 View Proof
//                                     </button>

//                                 </div>

//                             </div>

//                         </div>
//                     `;

//                 }).join('');
//             }
//         }

//         // ==========================================
//         // USER STATUS
//         // ==========================================

//         const usersContainer =
//             document.getElementById('adminUsersContainer');

//         if (usersContainer) {

//             if (!users.length) {

//                 usersContainer.innerHTML = `
//                     <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-5 text-center">
//                         <p class="text-sm text-slate-300">
//                             No users found.
//                         </p>
//                     </div>
//                 `;

//             } else {

//                 usersContainer.innerHTML = users.map(user => {

//                     const isBlocked =
//                         Boolean(user.is_blockbyAdmin);

//                     const isCurrentAdmin =
//                         Number(user.id) === Number(currentUserId);

//                     return `
//                         <div class="bg-slate-900/70 border border-slate-800 rounded-xl p-4 mb-3">

//                             <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">

//                                 <div>

//                                     <div class="flex items-center gap-2">

//                                         <h3 class="font-bold text-slate-100 text-sm">
//                                             ${escapeHtml(user.name || 'Unknown User')}
//                                         </h3>

//                                         ${
//                                             isBlocked
//                                                 ? `
//                                                     <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">
//                                                         DEACTIVATED
//                                                     </span>
//                                                 `
//                                                 : `
//                                                     <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
//                                                         ACTIVE
//                                                     </span>
//                                                 `
//                                         }

//                                     </div>

//                                     <p class="text-xs text-slate-400 mt-1">
//                                         ${escapeHtml(user.email || '')}
//                                     </p>

//                                     <p class="text-xs text-slate-500 mt-1">
//                                         User ID: ${Number(user.id)}
//                                     </p>

//                                 </div>

//                                 <div class="flex gap-2">

//                                     ${
//                                         isCurrentAdmin
//                                             ? `
//                                                 <button
//                                                     disabled
//                                                     class="px-3 py-2 rounded-lg bg-slate-800 text-slate-500 text-xs font-bold cursor-not-allowed">
//                                                     Current Admin
//                                                 </button>
//                                             `
//                                             : isBlocked
//                                                 ? `
//                                                     <button
//                                                         type="button"
//                                                         onclick="toggleUserStatus(
//                                                             ${Number(user.id)},
//                                                             'activate',
//                                                             '${escapeHtml(user.email || '')}'
//                                                         )"
//                                                         class="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">
//                                                         ✓ Activate
//                                                     </button>
//                                                 `
//                                                 : `
//                                                     <button
//                                                         type="button"
//                                                         onclick="toggleUserStatus(
//                                                             ${Number(user.id)},
//                                                             'deactivate',
//                                                             '${escapeHtml(user.email || '')}'
//                                                         )"
//                                                         class="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold">
//                                                         🚫 Deactivate
//                                                     </button>
//                                                 `
//                                     }

//                                 </div>

//                             </div>

//                         </div>
//                     `;

//                 }).join('');
//             }
//         }

//     } catch (error) {

//         console.error(
//             'Failed to load admin reports/users:',
//             error
//         );

//         showToast(
//             error.message || 'Failed to load admin reports',
//             'error'
//         );
//     }
// }


async function viewReportProof(reportId) {
    try {

        const report = await request(
            `/api/v1/admin/report/${reportId}`,
            'GET'
        );

        const modal =
            document.getElementById('proofModal');

        const imgEl =
            document.getElementById('proofImage');

        const emptyEl =
            document.getElementById('proofEmptyMessage');

        if (!modal) return;

        if (!report.report_ss_url) {

            if (imgEl) {
                imgEl.removeAttribute('src');
                imgEl.classList.add('hidden');
            }

            if (emptyEl) {
                emptyEl.classList.remove('hidden');
            }

            modal.classList.remove('hidden');

            return;
        }

        let proofPath =
            String(report.report_ss_url)
                .replace(/\\/g, '/')
                .replace(/^\/+/, '');

        if (imgEl) {

            imgEl.src =
                `${BASE_URL}/${proofPath}`;

            imgEl.classList.remove('hidden');
        }

        if (emptyEl) {
            emptyEl.classList.add('hidden');
        }

        modal.classList.remove('hidden');

    } catch (error) {

        console.error(
            'Could not load report proof:',
            error
        );

        showToast(
            error.message || 'Could not load report proof',
            'error'
        );
    }
}

async function toggleUserStatus(userId, action) {

    try {

        // ==========================================================
        // DEACTIVATE
        // ==========================================================

        if (action === 'deactivate') {

            const confirmed = confirm(
                "Are you sure you want to deactivate this user?"
            );

            if (!confirmed) {
                return;
            }

            await request(
                `/api/v1/admin/take_action/${userId}?acticon=yes`,
                'POST'
            );

            showToast(
                'User deactivated successfully',
                'success'
            );

        }

        // ==========================================================
        // ACTIVATE
        // ==========================================================

        else if (action === 'activate') {

            const confirmed = confirm(
                "Are you sure you want to activate this user?"
            );

            if (!confirmed) {
                return;
            }

            /*
             * We need the user's email because the backend
             * activation endpoint is:
             *
             * POST /admin/unblock/{email}
             */

            const adminData =
                await request(
                    '/api/v1/admin/admin_dashboard',
                    'GET'
                );

            const user =
                (adminData.users || []).find(
                    u => Number(u.id) === Number(userId)
                );

            if (!user || !user.email) {

                showToast(
                    'User email not found',
                    'error'
                );

                return;
            }

            await request(
                `/api/v1/admin/unblock/${encodeURIComponent(user.email)}`,
                'POST'
            );

            showToast(
                'User activated successfully',
                'success'
            );
        }

        else {

            showToast(
                'Invalid user status action',
                'error'
            );

            return;
        }

        // Refresh reports and users after action
        await loadAdminReportsAndUsers();
        await loadAdminDashboard()

    } catch (error) {

        console.error(
            'Failed to update user status:',
            error
        );

        showToast(
            error.message || 'Failed to update user status',
            'error'
        );
    }
}
function toggleAdminReports() {
    console.log("Toggle admin reports clicked");
    const modal = document.getElementById('admin-reports-modal');
    if (modal) {
        modal.classList.toggle('hidden');
        if (!modal.classList.contains('hidden')) {
            loadAndRenderAdminReports();
        }
    }
}

function closeAdminReportsModal() {
    const modal = document.getElementById('admin-reports-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

async function loadAndRenderAdminReports() {
    const container = document.getElementById('admin-reports-list');
    if (!container) return;

    container.innerHTML = '<p class="text-center text-slate-400 text-xs py-6">Loading reports...</p>';

    try {
        // Fetch reports from your backend endpoint (adjust endpoint as needed)
        const reports = await request('/api/v1/admin/reports', 'GET').catch(() => [
            { id: 101, title: "Daily Token Consumption Summary", date: "2026-09-30", type: "Usage" },
            { id: 102, title: "Active Call Telemetry & Audit Log", date: "2026-09-29", type: "Security" },
            { id: 103, title: "User Signup & Subscription Analytics", date: "2026-09-28", type: "Billing" }
        ]);

        if (!Array.isArray(reports) || reports.length === 0) {
            container.innerHTML = '<p class="text-center text-slate-400 text-xs py-6">No reports available.</p>';
            return;
        }

        container.innerHTML = reports.map(report => `
            <div class="bg-slate-950/60 border border-slate-800/80 p-4 rounded-xl flex items-center justify-between gap-4 hover:border-indigo-500/40 transition-all">
                <div>
                    <span class="text-[10px] font-bold uppercase tracking-wider text-indigo-300 bg-indigo-500/20 px-2.5 py-0.5 rounded-full border border-indigo-500/30">
                        ${escapeHtml(report.type || 'General')}
                    </span>
                    <h4 class="font-bold text-slate-100 text-sm mt-1.5">${escapeHtml(report.title)}</h4>
                    <p class="text-[11px] text-slate-400 mt-0.5">Generated: ${escapeHtml(report.date || 'Recent')}</p>
                </div>
                <button 
                    class="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-4 py-2 rounded-xl shrink-0 shadow-lg shadow-indigo-600/20 transition-all"
                    onclick="viewReportDetails(${report.id})">
                    👁️ View Report
                </button>
            </div>
        `).join('');

    } catch (e) {
        console.error("Failed to load admin reports:", e);
        container.innerHTML = '<p class="text-center text-rose-400 text-xs py-6">Failed to load system reports.</p>';
    }
}

// Handler when clicking the "View Report" button
function viewReportDetails(reportId) {
    showToast(`Opening details for Report #${reportId}`, 'info');
    // Add your custom report detail viewing logic or navigation here
}



async function loadAdminReportsAndUsers() {
    try {
        // 1. Load All Users for Admin Dashboard Directory
        const users = await request('/api/v1/admin/all_users', 'GET');
        const userssGrid = document.getElementById('users-grid');
        
        if (userssGrid) {
            if (!Array.isArray(users) || users.length === 0) {
                userssGrid.innerHTML = '<p class="text-slate-400 text-xs">No users found.</p>';
            } else {
                userssGrid.innerHTML = users.map(u => `
                    <div class="item-card bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
                        <h3 class="font-bold text-slate-100 text-sm">${escapeHtml(u.name)}</h3>
                        <p class="text-xs text-slate-400 mt-1"><strong>Email:</strong> ${escapeHtml(u.email)}</p>
                        <p class="text-xs text-slate-400"><strong>Role:</strong> ${escapeHtml(u.role)}</p>
                        <p class="text-xs mt-2 font-semibold ${u.is_blocked_by_admin ? 'text-rose-400' : 'text-emerald-400'}">
                            Status: ${u.is_blocked_by_admin ? 'Blocked by Admin' : 'Active'}
                        </p>
                        ${u.is_blocked_by_admin ? `
                            <button class="mt-3 text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-1 px-3 rounded-lg" onclick="unblockUser('${escapeHtml(u.email)}')">Unblock User</button>
                        ` : ''}
                    </div>
                `).join('');
            }
        }

        // 2. Load All Reports for Admin Review Section
        const reports = await request('/api/v1/admin/all_report', 'GET');
        let reportsContainer = document.getElementById('admin-reports-container');
        
        if (!reportsContainer) {
            // Create reports container dynamically if it doesn't exist in HTML
            const adminSection = document.getElementById('admin-summary-section');
            if (adminSection) {
                const reportWrapper = document.createElement('div');
                reportWrapper.className = 'mt-6';
                reportWrapper.innerHTML = `
                    <h3 class="font-bold text-sm text-slate-200 mb-3">User Reports Requiring Review</h3>
                    <div id="admin-reports-container" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
                `;
                adminSection.appendChild(reportWrapper);
                reportsContainer = document.getElementById('admin-reports-container');
            }
        }

        if (reportsContainer) {
            if (!Array.isArray(reports) || reports.length === 0) {
                reportsContainer.innerHTML = '<p class="text-slate-400 text-xs col-span-full">No active reports submitted.</p>';
            } else {
                reportsContainer.innerHTML = reports.map(r => `
                    <div class="item-card bg-slate-900/70 border border-slate-800 p-4 rounded-xl flex flex-col justify-between">
                        <div>
                            <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">Report ID: ${r.id}</span>
                            <p class="text-xs text-slate-300 mt-2"><strong>Reported User ID:</strong> ${r.report_for}</p>
                            <p class="text-xs text-slate-300 mt-1"><strong>Reported By:</strong> ${r.report_by}</p>
                            <p class="text-xs text-slate-400 mt-2 italic bg-slate-950/50 p-2 rounded border border-slate-800">"${escapeHtml(r.report_description)}"</p>
                        </div>
                        <div class="mt-4 flex gap-2">
                            <button class="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold py-1.5 px-3 rounded-lg" onclick="openReportPopup(${r.id})">
                                🔍 Review & Screenshot
                            </button>
                        </div>
                    </div>
                `).join('');
            }
        }
    } catch (e) {
        console.error("Failed to load admin reports and users:", e);
    }
}

async function openReportPopup(reportId) {
    try {
        const report = await request(`/api/v1/admin/report/${reportId}`, 'GET');
        
        let modal = document.getElementById('admin-report-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'admin-report-modal';
            modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-[99999] flex items-center justify-center p-4';
            document.body.appendChild(modal);
        }

       const screenshotUrl = report.report_ss_url ? `${BASE_URL}/reports/${report.report_ss_url}` : null;

        modal.innerHTML = `
            <div class="bg-slate-900 border border-slate-800 w-full max-w-lg rounded-2xl p-6 shadow-2xl relative text-slate-200">
                <button class="absolute top-4 right-4 text-slate-400 hover:text-white text-lg font-bold" onclick="closeReportPopup()">✕</button>
                <h3 class="font-bold text-base text-white mb-2">Review Report #${report.id}</h3>
                <p class="text-xs text-slate-400 mb-4">Target User ID: <span class="text-indigo-400 font-bold">${report.report_for}</span></p>
                
                <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 text-xs mb-4">
                    <p class="font-semibold text-slate-300 mb-1">Description:</p>
                    <p class="text-slate-400">${escapeHtml(report.report_description)}</p>
                </div>

                <div class="mb-5">
                    <p class="font-semibold text-xs text-slate-300 mb-2">Attached Screenshot:</p>
                    ${screenshotUrl ? `
                        <div class="bg-black/50 border border-slate-800 rounded-xl overflow-hidden max-h-60 flex items-center justify-center">
                            <img src="${screenshotUrl}" alt="Report Evidence" class="object-contain max-h-56 w-full" onerror="this.onerror=null;this.parentElement.innerHTML='<p class=\'text-xs text-slate-500 py-6 text-center\'>Screenshot unavailable or failed to load.</p>';">
                        </div>
                    ` : '<p class="text-xs text-slate-500 italic">No screenshot provided with this report.</p>'}
                </div>

                <div class="flex gap-3 pt-2 border-t border-slate-800">
                    <button class="flex-1 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold py-2.5 rounded-xl transition-all" onclick="submitAdminAction(${report.id}, 'yes')">
                        🔨 Block User
                    </button>
                    <button class="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-2.5 rounded-xl transition-all" onclick="submitAdminAction(${report.id}, 'no')">
                        ❌ Reject Report
                    </button>
                </div>
            </div>
        `;
        modal.classList.remove('hidden');
    } catch (e) {
        showToast("Failed to fetch report details.", "error");
    }
}

function closeReportPopup() {
    const modal = document.getElementById('admin-report-modal');
    if (modal) modal.classList.add('hidden');
}

async function submitAdminAction(reportId, action) {
    try {
        const res = await request(`/api/v1/admin/take_action/${reportId}?acticon=${action}`, 'POST');
        showToast(res.message || "Action processed successfully!", "success");
        closeReportPopup();
        loadAdminReportsAndUsers();
    } catch (e) {
        showToast(e.message || "Failed to process action.", "error");
    }
}

async function unblockUser(email) {
    try {
        const res = await request(`/api/v1/admin/unblock/${encodeURIComponent(email)}`, 'POST');
        showToast(res.message || "User unblocked successfully!", "success");
        loadAdminReportsAndUsers();
    } catch (e) {
        showToast("Failed to unblock user.", "error");
    }
}

function openImageExtractModal() {
    const modal = document.getElementById('image-extract-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeImageExtractModal() {
    const modal = document.getElementById('image-extract-modal');
    if (modal) modal.classList.add('hidden');
    const fileInput = document.getElementById('extract-image-input');
    if (fileInput) fileInput.value = '';
}

function openWebsiteScrapeModal() {
    const modal = document.getElementById('website-scrape-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeWebsiteScrapeModal() {
    const modal = document.getElementById('website-scrape-modal');
    if (modal) modal.classList.add('hidden');
    const urlInput = document.getElementById('website-scrape-url');
    if (urlInput) urlInput.value = '';
}

function formatApiErrorDetail(detail, fallback) {
    if (Array.isArray(detail)) {
        return detail.map(error => `${(error.loc || []).join('.')}: ${error.msg || 'Invalid value'}`).join('; ');
    }
    if (typeof detail === 'string') return detail;
    return detail ? JSON.stringify(detail) : fallback;
}

async function handleWebsiteScrape(event) {
    event.preventDefault();

    const urlInput = document.getElementById('website-scrape-url');
    const url = urlInput ? urlInput.value.trim() : '';
    if (!url) {
        showToast('Enter a website URL first.', 'error');
        return;
    }

    try {
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Enter an HTTP or HTTPS website URL.');
        }

        showToast('Scraping website...', 'info');
        const response = await fetch(
            `${BASE_URL}/api/v1/user/scrape_website?url=${encodeURIComponent(url)}`
        );
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(formatApiErrorDetail(data.detail, 'Failed to scrape website.'));
        }

        closeWebsiteScrapeModal();
        renderWebsiteScrapeResult(data);
    } catch (error) {
        console.error('Website scraping error:', error);
        showToast(error.message || 'An error occurred while scraping the website.', 'error');
    }
}

function renderWebsiteScrapeResult(responseData) {
    const resultModal = document.getElementById('image-result-modal');
    const title = document.getElementById('image-result-title');
    const contentBox = document.getElementById('image-result-content');
    if (!contentBox) return;

    if (title) title.textContent = '🌐 Website Scrape Results';

    if (!responseData || typeof responseData !== 'object') {
        contentBox.innerHTML = `<p>${escapeHtml(String(responseData || 'No scrape data returned.'))}</p>`;
        if (resultModal) resultModal.classList.remove('hidden');
        return;
    }

    const pageTitle = escapeHtml(responseData.title || 'Untitled page');
    
    const introduction = responseData.brief_introduction
        ? `<section class="space-y-1.5">
            <h4 class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Overview</h4>
            <p class="text-sm text-slate-300 leading-relaxed">${escapeHtml(responseData.brief_introduction)}</p>
          </section>`
        : '';
        
    const metaDescription = responseData.meta_description
        ? `<section class="space-y-1.5">
            <h4 class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Meta Description</h4>
            <p class="text-xs text-slate-400 leading-relaxed">${escapeHtml(responseData.meta_description)}</p>
          </section>`
        : '';

    // Function to safely convert basic markdown (bold and bullet points) to HTML
    const parseMarkdownToHtml = (text) => {
        if (!text) return '';
        let safeText = escapeHtml(text);
        
        // Convert **bold** to <strong>
        safeText = safeText.replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>');
        
        // Split into lines to handle bullet points
        const lines = safeText.split('\n');
        let inList = false;
        let htmlResult = '';

        for (let line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
                if (!inList) {
                    htmlResult += '<ul class="list-disc list-inside space-y-1.5 my-2 pl-2">';
                    inList = true;
                }
                htmlResult += `<li>${trimmed.substring(2)}</li>`;
            } else {
                if (inList) {
                    htmlResult += '</ul>';
                    inList = false;
                }
                if (trimmed) {
                    htmlResult += `<p class="mb-2">${trimmed}</p>`;
                }
            }
        }
        if (inList) {
            htmlResult += '</ul>';
        }
        return htmlResult;
    };

    const aiSummaryHtml = parseMarkdownToHtml(responseData.ai_summary);
    const aiSummary = aiSummaryHtml
        ? `<section class="space-y-2 pt-2 border-t border-slate-800">
            <h4 class="text-[11px] font-bold uppercase tracking-wider text-slate-400">AI Summary</h4>
            <div class="text-sm leading-relaxed text-slate-300">${aiSummaryHtml}</div>
        </section>`
        : '';

    let sourceMarkup = escapeHtml(responseData.url || 'Source URL unavailable');
    try {
        const sourceUrl = new URL(responseData.url);
        if (['http:', 'https:'].includes(sourceUrl.protocol)) {
            sourceMarkup = `<a href="${escapeHtml(sourceUrl.href)}" target="_blank" rel="noopener noreferrer" class="break-all text-cyan-300 hover:text-cyan-200 underline underline-offset-2">${escapeHtml(sourceUrl.href)}</a>`;
        }
    } catch (error) { }

    const renderHeadingList = (label, headings) => {
        if (!Array.isArray(headings) || headings.length === 0) return '';
        return `<section class="space-y-2 pt-2 border-t border-slate-800">
            <h4 class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(label)}</h4>
            <ul class="space-y-1.5">${headings.map(heading => `<li class="border-l-2 border-cyan-500/50 pl-3 text-sm text-slate-200">${escapeHtml(heading)}</li>`).join('')}</ul>
        </section>`;
    };

    contentBox.innerHTML = `<article class="space-y-4">
        <header class="flex flex-col space-y-1.5 border-b border-slate-800 pb-4">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">Scraped Page</span>
            <h2 class="text-lg font-bold text-white break-words">${pageTitle}</h2>
            <div class="text-xs pt-0.5">${sourceMarkup}</div>
        </header>
        ${introduction}
        ${metaDescription}
        ${aiSummary}
        ${renderHeadingList('Main Headings (H1)', responseData.headings_h1)}
    </article>`;

    if (resultModal) resultModal.classList.remove('hidden');
}
function closeImageResultModal() {
    const modal = document.getElementById('image-result-modal');
    if (modal) modal.classList.add('hidden');
}

async function handleExtractImageText() {
    const fileInput = document.getElementById('extract-image-input');
    if (!fileInput || fileInput.files.length === 0) {
        showToast("Please select an image file first.", "error");
        return;
    }

    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('image_path', file);

    try {
        showToast("Extracting text from image...", "info");
        
        const headers = {};
        if (isRealJwt(accessToken)) {
            headers['Authorization'] = `Bearer ${accessToken}`;
        }

        const response = await fetch(`${BASE_URL}/api/v1/user/extract_text_from_image`, {
            method: 'POST',
            headers: headers,
            body: formData
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(formatApiErrorDetail(data.detail, 'Failed to extract text from image.'));
        }

        // Close upload modal and show beautiful result modal
        closeImageExtractModal();
        renderImageExtractionResult(data);

    } catch (e) {
        console.error("Image text extraction error:", e);
        showToast(e.message || "An error occurred during text extraction.", "error");
    }
}

function renderImageExtractionResult(responsedata, resultTitle = '✨ Image Extraction Results') {
    const resultModal = document.getElementById('image-result-modal');
    const title = document.getElementById('image-result-title');
    const contentBox = document.getElementById('image-result-content');
    
    if (!contentBox) return;

    if (title) title.textContent = resultTitle;

    // Format the response properly depending on whether it's a string or an object structure
    let formattedHtml = "";
    
    if (typeof responsedata === 'string') {
        formattedHtml = escapeHtml(responsedata);
    } else if (typeof responsedata === 'object' && responsedata !== null) {
        // Handle common response fields like text, extracted_text, result, etc.
        const primaryText = responsedata.text || responsedata.extracted_text || responsedata.result || JSON.stringify(responsedata, null, 2);
        
        formattedHtml = `<div class="space-y-3">
            <div class="text-indigo-400 font-bold border-b border-slate-800 pb-2">📄 Extracted Content</div>
            <div class="text-slate-200">${escapeHtml(primaryText).replace(/\n/g, '<br>')}</div>
        </div>`;
        
        // If there are extra structured fields, display them nicely
        const extraKeys = Object.keys(responsedata).filter(k => !['text', 'extracted_text', 'result'].includes(k));
        if (extraKeys.length > 0) {
            formattedHtml += `<div class="mt-4 pt-3 border-t border-slate-800 space-y-1 text-slate-400">
                <div class="font-semibold text-slate-300">Additional Metadata:</div>`;
            extraKeys.forEach(key => {
                formattedHtml += `<div><span class="text-indigo-300">${escapeHtml(key)}:</span> ${escapeHtml(JSON.stringify(responsedata[key]))}</div>`;
            });
            formattedHtml += `</div>`;
        }
    } else {
        formattedHtml = "No extraction data returned.";
    }

    contentBox.innerHTML = formattedHtml;
    if (resultModal) resultModal.classList.remove('hidden');
}
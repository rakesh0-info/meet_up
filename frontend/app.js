// const BASE_URL = 'http://127.0.0.1:8000';
 const BASE_URL = 'https://meet-up-0kqq.onrender.com';
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
        try { speechRecognizer.stop(); } catch(e){}
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
        try { speechRecognizer.stop(); } catch(e){}
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

function publishTranscript(text, speaker) {
    const transcript = {
        type: "TRANSCRIPT",
        text,
        speaker,
        participantName: speaker,
        timestamp: Date.now()
    };

    if (callWs && callWs.readyState === WebSocket.OPEN) {
        callWs.send(JSON.stringify({
            ...transcript,
            type: "LIVEKIT_TRANSCRIPT"
        }));
    }

    if (livekitRoom && livekitRoom.localParticipant) {
        try {
            const payload = new TextEncoder().encode(JSON.stringify(transcript));
            livekitRoom.localParticipant.publishData(payload, { reliable: true });
        } catch (error) {
            console.warn("LiveKit transcript publish warning:", error);
        }
    }
}

function showCaption(speaker, text) {
    const overlay = document.getElementById('captionOverlay');
    if (!overlay) return;

    document.getElementById('captionSpeaker').innerText = speaker;
    document.getElementById('captionText').innerText = text;
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
    entry.innerHTML = `<span class="speaker">${speaker}:</span> ${text}`;
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

async function request(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

    const config = { method, headers };
    if (body) config.body = JSON.stringify(body);

    const response = await fetch(`${BASE_URL}${endpoint}`, config);
    const data = await response.json();

    if (!response.ok) {
        let errorMessage = 'An error occurred';
        if (typeof data.detail === 'string') {
            errorMessage = data.detail;
        } else if (Array.isArray(data.detail)) {
            errorMessage = data.detail.map(err => `${err.loc ? err.loc.join('.') : ''}: ${err.msg}`).join('\n');
        } else if (typeof data.detail === 'object') {
            errorMessage = JSON.stringify(data.detail);
        }
        alert(errorMessage);
        throw new Error(errorMessage);
    }
    return data;
}


async function markConversationAsSeen(senderId) {
    try {
        await request('/api/v1/chats/mark-seen', 'PATCH', { sender_id: senderId });
    } catch (e) {
        console.error("Failed to mark messages as seen:", e);
    }
}

function switchAuthTab(tab) {
    document.getElementById('tab-login-btn').className = tab === 'login' ? 'active' : '';
    document.getElementById('tab-register-btn').className = tab === 'register' ? 'active' : '';
    document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
}

async function handleRegister(event) {
    event.preventDefault();
    const name = document.getElementById('reg-name').value;
    currentEmail = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;

    try {
        await request('/api/v1/user/register', 'POST', { name, email: currentEmail, password });
        showOTPScreen();
    } catch (e) {
        console.error(e);
    }
}

async function handleLogin(event) {
    event.preventDefault();
    currentEmail = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    try {
        const res = await request('/api/v1/user/login', 'POST', { email: currentEmail, password });

        if (res.message && res.message.toLowerCase().includes('unverified')) {
            showOTPScreen();
        } else if (res.access_token) {
            accessToken = res.access_token;
            localStorage.setItem('access_token', accessToken);
            currentUserRole = res.role;
            loadDashboard();
        }
    } catch (e) {
        console.error(e);
    }
}

function showOTPScreen() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('otp-screen').classList.remove('hidden');
    document.getElementById('otp-target-email').innerText = currentEmail;
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
        const response = await request(
            `/api/v1/user/forgetpass?email=${encodeURIComponent(email)}`,
            'POST'
        );
        currentEmail = email;
        document.getElementById('reset-otp-email').innerText = email;
        document.getElementById('password-reset-email-screen').classList.add('hidden');
        document.getElementById('password-reset-otp-screen').classList.remove('hidden');
    } catch (error) {
        console.error('Forgot password request failed:', error);
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
    }
}

async function loadDashboard() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('otp-screen').classList.add('hidden');
    document.getElementById('app-header').classList.remove('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');

    const me = await request('/api/v1/user/me', 'GET');
    currentUserId = me.id;
    currentEmail = me.email;
    currentUserRole = me.role;

    document.getElementById('greeting-text').innerText = `Welcome, ${currentEmail}`;
    document.getElementById('role-badge').innerText = currentUserRole.toUpperCase();
    updateWalletDisplay(me.token_balance || 0);

    if (currentUserRole.toLowerCase() === 'admin') {
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
    document.getElementById('admin-summary-section').classList.remove('hidden');

    // Show admin call history section
    const adminCallsSection = document.getElementById('admin-calls-section');
    if (adminCallsSection) {
        adminCallsSection.classList.remove('hidden');
    }

    try {
        const adminData = await request(
            '/api/v1/admin/admin_dashboard',
            'GET'
        );

        console.log("ADMIN DASHBOARD RESPONSE:", adminData);

        // =========================================================
        // ADMIN USER / WALLET INFORMATION
        // =========================================================

        const me = adminData.users.find(
            u => u.email === currentEmail
        );

        if (me) {
            currentUserId = me.id;
            updateWalletDisplay(
                me.current_token_balance || 0
            );
        }

        // =========================================================
        // ADMIN SUMMARY
        // =========================================================

        document.getElementById('admin-usage-card').innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">

                <div class="item-card">
                    <h3>Total Tokens Used Today</h3>
                    <p class="text-2xl font-bold text-cyan-400">
                        ${adminData.total_tokens_used_today || 0}
                    </p>
                </div>

                <div class="item-card">
                    <h3>Total System Users</h3>
                    <p class="text-2xl font-bold text-purple-400">
                        ${adminData.total_users || 0}
                    </p>
                </div>

            </div>
        `;

        // =========================================================
        // USERS
        // =========================================================

        const usersGrid = document.getElementById('users-grid');

        const otherUsers = (adminData.users || []).filter(
            u => u.email !== currentEmail
        );

        usersGrid.innerHTML = otherUsers.map(u => `
            <div class="item-card">

                <h3>
                    ${escapeHtml(u.name || u.email)}
                </h3>

                <p>
                    <strong>Email:</strong>
                    ${escapeHtml(u.email)}
                </p>

                <p>
                    <strong>Role:</strong>
                    ${escapeHtml(u.role || 'N/A')}
                </p>

                <p>
                    <strong>Wallet Balance:</strong>
                    ${u.current_token_balance || 0} Tokens
                </p>

                <p>
                    <strong>Tokens Used:</strong>
                    ${u.tokens_used || 0}
                </p>

            </div>
        `).join('');

        // =========================================================
        // ADMIN CALL HISTORY
        // =========================================================

        renderAdminCalls(adminData.calls || []);

    } catch (e) {

        console.error(
            "Error loading admin dashboard:",
            e
        );

        const callsList =
            document.getElementById('admin-calls-list');

        if (callsList) {
            callsList.innerHTML = `
                <p class="empty-msg text-rose-400">
                    Failed to load call history.
                </p>
            `;
        }
    }
}

function renderAdminCalls(calls) {

    const callsList =
        document.getElementById('admin-calls-list');

    if (!callsList) {
        console.warn(
            "admin-calls-list element was not found"
        );
        return;
    }

    console.log(
        "Rendering admin calls:",
        calls
    );

    // No calls
    if (!Array.isArray(calls) || calls.length === 0) {

        callsList.innerHTML = `
            <div class="col-span-full item-card text-center">
                <div class="text-4xl mb-3">
                    📹
                </div>

                <h3>
                    No Completed Calls
                </h3>

                <p>
                    No video calls have been completed yet.
                </p>
            </div>
        `;

        return;
    }

    callsList.innerHTML = calls.map(call => {

        const startTime =
            call.start_time
                ? new Date(call.start_time).toLocaleString()
                : 'Unknown';

        const endTime =
            call.end_time
                ? new Date(call.end_time).toLocaleString()
                : 'Unknown';

        const duration =
            Number(call.duration_seconds || 0);

        const minutes =
            Math.floor(duration / 60);

        const seconds =
            duration % 60;

        const durationText =
            `${minutes}m ${seconds}s`;

        const status =
            String(call.status || 'UNKNOWN')
                .replace(/^.*\./, '');

        return `
            <div class="item-card">

                <div class="flex justify-between items-start gap-3">

                    <div>
                        <h3>
                            📹 Video Call
                        </h3>

                        <p class="text-xs text-slate-500 break-all">
                            Room:
                            ${escapeHtml(call.room_id || 'N/A')}
                        </p>
                    </div>

                    <span class="px-2 py-1 rounded-full text-xs font-bold
                        ${status.toUpperCase() === 'COMPLETED'
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        }">

                        ${escapeHtml(status)}

                    </span>

                </div>

                <div class="mt-4 space-y-2">

                    <p>
                        <strong>Sender:</strong>
                        ${escapeHtml(
                            call.sender_name || 'Unknown Sender'
                        )}
                    </p>

                    <p>
                        <strong>Receiver:</strong>
                        ${escapeHtml(
                            call.receiver_name || 'Unknown Receiver'
                        )}
                    </p>

                    <p>
                        <strong>Tokens Consumed:</strong>
                        ${Number(call.tokens_consumed || 0)}
                    </p>

                    <p>
                        <strong>Duration:</strong>
                        ${durationText}
                    </p>

                    <p>
                        <strong>Started:</strong>
                        ${escapeHtml(startTime)}
                    </p>

                    <p>
                        <strong>Ended:</strong>
                        ${escapeHtml(endTime)}
                    </p>

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
    }
}

async function loadUserDashboard() {
    document.getElementById('admin-summary-section').classList.add('hidden');
    try {
        const dashboard = await request('/api/v1/user/user_dashboard', 'GET');
        const friends = await request('/api/v1/user/get_all_friend', 'GET');
        

        if (dashboard.user_info) {
            currentUserId = dashboard.user_info.id;
            currentEmail = dashboard.user_info.email;
            currentUserRole = dashboard.user_info.role || currentUserRole;
            updateWalletDisplay(dashboard.user_info.token_balance || 0);
        }

        renderFriends(friends);
        renderCompletedCalls(dashboard.completed_calls || []);

        const usersGrid = document.getElementById('users-grid');
        const availableUsers = dashboard.available_users || [];

        usersGrid.innerHTML = availableUsers.map(u => {
            // Check if the card being mapped is the admin user
            const isAdminCard = u.name === "admin" && u.email === "admin@gmail.com";

            return `
                <div class="item-card">
                    <h3>${escapeHtml(u.name || u.email)}</h3>
                    <div style="display: flex; gap: 8px; margin-top: 5px;">
                        <button 
                            ${isAdminCard ? 'disabled class="opacity-50 cursor-not-allowed bg-slate-800 text-slate-500 border border-slate-700 py-2 px-3 rounded-xl text-xs"' : 'py-2 px-3 rounded-xl text-xs bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'} 
                            onclick="sendFriendRequest(${u.id})">
                            Add Friend
                        </button>
                         <button 
                          ${isAdminCard ? 'disabled class="opacity-50 cursor-not-allowed bg-slate-800 text-slate-500 border border-slate-700 py-2 px-3 rounded-xl text-xs"' : 'py-2 px-3 rounded-xl text-xs bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'} 
                         class="btn-success text-xs py-2 px-3 rounded-xl" onclick="initiateCall(${u.id})">Call User</button>
                    </div>
                </div>
            `;
        }).join('');

    } catch (e) {
        console.error("Error loading user dashboard", e);
    }
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

    if (!friends.length) {
        friendsGrid.innerHTML = '<p class="empty-msg">No accepted friends yet. Add friends from the directory above!</p>';
        return;
    }

    friendsGrid.innerHTML = friends.map(friend => {
        const unreadCount = unreadCounts[friend.id] || 0;
        return `
            <div class="item-card friend-card relative" data-friend-id="${friend.id}">
                ${unreadCount > 0 ? `<span class="friend-card-badge">${unreadCount}</span>` : ''}
                <div>
                    <h3>${escapeHtml(friend.name || friend.email)}</h3>
                    <p>${escapeHtml(friend.email || '')}</p>
                </div>
                <div class="flex gap-2 mt-4">
                    <button class="flex-1 bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/30 text-xs py-2 rounded-xl font-bold" onclick="openChat(${friend.id}, '${escapeHtml(friend.name || friend.email)}')">💬 Chat</button>
                    <button class="btn-success text-xs py-2 px-3 rounded-xl" onclick="initiateCall(${friend.id})">Call</button>
                </div>
            </div>
        `;
    }).join('');
}



function renderCompletedCalls(calls) {
    const callsList = document.getElementById('completed-calls-list');
    if (!callsList) return;

    if (!calls.length) {
        callsList.innerHTML = '<p class="empty-msg">No completed calls yet.</p>';
        return;
    }

    callsList.innerHTML = calls.map(call => `
        <div class="item-card">
            <h3>Room ${escapeHtml(call.room_id)}</h3>
            <p>Completed: ${call.created_at ? new Date(call.created_at).toLocaleString() : 'Unknown'}</p>
            <button onclick="viewSummaryFromNotif('${escapeHtml(call.room_id)}', null)">View Summary</button>
        </div>
    `).join('');
}

async function sendFriendRequest(receiverId) {
    try {
        const res = await request(`/api/v1/user/send_friend_request?receiver_id=${receiverId}`, 'POST');
        alert(res.message);
    } catch (e) {
        console.error(e);
    }
}

async function fetchSubscriptions() {
    try {
        const plans = await request('/api/v1/user/all_subscription', 'GET');
        const container = document.getElementById('plans-grid');

        container.innerHTML = plans.map(p => `
            <div class="item-card">
                <h3>${p.name}</h3>
                <p><strong>Tokens:</strong> ${p.token_amount}</p>
                <p><strong>Price:</strong> $ ${p.amount_to_pay}</p>
                ${currentUserRole.toLowerCase() === 'user' ? `<button onclick="subscribePlan(${p.id})">Buy Tokens</button>` : ''}
            </div>
        `).join('');
    } catch (e) {
        console.error(e);
    }
}

async function subscribePlan(planId) {
    if (!accessToken) {
        alert('Please log in before buying a token plan.');
        return;
    }

    if (currentUserRole.toLowerCase() !== 'user') {
        alert('Only regular users can activate token plans.');
        return;
    }

    try {
        const res = await request(`/api/v1/user/activate_plan?plan_id=${planId}`, 'POST');
        
        if (res.user_wallet && res.user_wallet.current_balance !== undefined) {
            updateWalletDisplay(res.user_wallet.current_balance);
        }

        if (res.checkout_url) {
            window.open(res.checkout_url, '_blank');
        }
    } catch (e) {
        console.error(e);
    }
}

function updateWalletDisplay(balance) {
    document.getElementById('wallet-token-count').innerText = balance;
}

async function refreshCurrentUserBalance() {
    try {
        const me = await request('/api/v1/user/me', 'GET');
        if (me.token_balance !== undefined) {
            updateWalletDisplay(me.token_balance);
        }
    } catch (error) {
        console.error('Failed to refresh wallet balance:', error);
    }
}

async function fetchNotifications() {
    const fetchSequence = ++notificationFetchSequence;
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
    } catch (e) {
        console.error(e);
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

    if (!notifications || notifications.length === 0) {
        badge.classList.add('hidden');
        container.innerHTML = '<p class="empty-msg">No unread notifications</p>';
        return;
    }

    badge.classList.remove('hidden');
    badge.innerText = notifications.length;

    container.innerHTML = notifications.map(n => {
        let senderId =
            n.sender_id ||
            n.metadata?.sender_id ||
            n.data?.sender_id;

        let roomId =
            n.room_id ||
            n.metadata?.room_id ||
            n.data?.room_id ||
            n.roomId;

        const rawMessage = (n.message || '').toString();

        // Extract sender ID from the message if necessary
        const senderMarker = rawMessage.match(
            /\[sender_id:(\d+)\]/i
        );

        if (!senderId && senderMarker) {
            senderId = Number(senderMarker[1]);
        }

        const msg = rawMessage.replace(
            /\s*\[sender_id:\d+\]/i,
            ''
        );

        // Extract room UUID from the message if necessary
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

        const isIncomingCall =
            n.notification_type === 'INCOMING_CALL' ||
            (
                msg.toLowerCase().includes('incoming') &&
                msg.toLowerCase().includes('call')
            );

        const isAcceptedCall =
            n.notification_type === 'CALL_ACCEPTED';

        const isRejectedCall =
            n.notification_type === 'CALL_REJECTED';

        const isSummaryNotif =
            n.notification_type === 'CALL_SUMMARY_READY' ||
            msg.toLowerCase().includes('summary');

        const isFriendReq =
            n.notification_type === 'FRIEND_REQUEST' ||
            (
                msg.toLowerCase().includes('friend') &&
                msg.toLowerCase().includes('request')
            );

        return `
            <div
                class="notif-item cursor-pointer hover:bg-slate-800/50 p-2 rounded transition-all"
                onclick="markNotificationAsRead(${n.id}, event)"
            >
                <p>${msg}</p>

                ${
                    isFriendReq &&
                    Number.isInteger(Number(senderId))
                        ? `
                    <div
                        class="notif-actions"
                        onclick="event.stopPropagation()"
                    >
                        <button
                            class="btn-success"
                            onclick="respondRequest(${senderId}, 'yes', ${n.id})"
                        >
                            Accept
                        </button>

                        <button
                            class="btn-danger"
                            onclick="respondRequest(${senderId}, 'no', ${n.id})"
                        >
                            Reject
                        </button>
                    </div>
                    `
                        : ''
                }

                ${
                    isIncomingCall
                        ? `
                    <div
                        class="notif-actions"
                        onclick="event.stopPropagation()"
                    >
                        <button
                            class="btn-success"
                            onclick="respondToCall('${roomId || ''}', true, ${n.id})"
                        >
                            Accept Call
                        </button>

                        <button
                            class="btn-danger"
                            onclick="respondToCall('${roomId || ''}', false, ${n.id})"
                        >
                            Reject
                        </button>
                    </div>
                    `
                        : ''
                }

                ${
                    isAcceptedCall && roomId
                        ? `
                    <div
                        class="notif-actions"
                        onclick="event.stopPropagation()"
                    >
                        <button
                            class="btn-success"
                            onclick="joinAcceptedCall('${roomId}', ${n.id})"
                        >
                            Join Call
                        </button>
                    </div>
                    `
                        : ''
                }

                ${
                    isRejectedCall
                        ? '<p>Call was rejected.</p>'
                        : ''
                }

                ${
                    isSummaryNotif
                        ? `
                    <div
                        class="notif-actions"
                        onclick="event.stopPropagation()"
                    >
                        <button
                            class="btn-success"
                            onclick="viewSummaryFromNotif('${roomId || ''}', ${n.id})"
                        >
                            View Summary
                        </button>
                    </div>
                    `
                        : ''
                }
            </div>
        `;
    }).join('');
}

async function joinAcceptedCall(roomId, notificationId) {
    if (notificationId) {
        await request(`/api/v1/notifications/${notificationId}/read`, 'PATCH');
    }
    fetchNotifications();
    currentRoomId = roomId;
    lastRoomId = roomId;
    await openCallUI(roomId);
}


async function viewSummaryFromNotif(roomId, notificationId) {
    if (notificationId) {
        await request(`/api/v1/notifications/${notificationId}/read`, 'PATCH');
        fetchNotifications();
    }
    if (roomId) lastRoomId = roomId;
    toggleNotifications();
    await fetchSummary();
}

async function respondRequest(senderId, status, notificationId) {
    try {
        await request('/api/v1/user/update_request', 'PUT', { sender_id: parseInt(senderId), status });
        if (notificationId) {
            await request(`/api/v1/notifications/${notificationId}/read`, 'PATCH');
        }
        fetchNotifications();
    } catch (e) {
        console.error("Failed to update request:", e);
    }
}

function toggleNotifications() {
    document.getElementById('notif-dropdown').classList.toggle('hidden');
}

let notificationReconnectTimeout = null;

function initNotificationWebSocket() {
    if (!currentUserId) return;
    if (notifWs) notifWs.close();

    const wsUrl = BASE_URL.replace(/^http/, 'ws');
    notifWs = new WebSocket(
        `${wsUrl}/api/v1/notifications/ws/${currentUserId}?token=${encodeURIComponent(accessToken)}`
    );

    notifWs.onopen = () => {
        console.log("Notification WebSocket connected.");
        if (notificationReconnectTimeout) {
            clearTimeout(notificationReconnectTimeout);
            notificationReconnectTimeout = null;
        }
        fetchNotifications();
    };

    notifWs.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            const notification = payload.notification || payload.data || payload;
            if (notification && (notification.notification_type || notification.message || notification.id)) {
                addRealtimeNotification(notification);
            }
        } catch (e) {
            console.warn("Notification WebSocket payload warning:", e);
        }
        fetchNotifications();
    };

    notifWs.onerror = (err) => {
        console.error("Notification WebSocket error:", err);
    };

    notifWs.onclose = () => {
        console.log("Notification WebSocket closed. Reconnecting in 3 seconds...");
        notificationReconnectTimeout = setTimeout(() => {
            initNotificationWebSocket();
        }, 3000);
    };
}

async function initiateCall(receiverId) {
    try {
        const res = await request('/api/v1/call/request_call', 'POST', { receiver_id: receiverId });
        alert(`Call requested successfully! Room ID: ${res.room_id}`);
        currentRoomId = res.room_id;
        lastRoomId = res.room_id;
        // Wait for the receiver's CALL_ACCEPTED notification before joining.
    } catch (e) {
        console.error("Failed to initiate call:", e);
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
        transcriptBox.innerHTML = '<p class="empty-msg">Transcripts will render live during the call...</p>';
    }

    document.getElementById('video-call-section').classList.remove('hidden');
    document.getElementById('active-room-display').innerText = roomId;

    connectCallWebSocket(roomId);
    await joinVideoCallSession(roomId);
}

async function joinVideoCallSession(roomId) {
    try {
        const tokenData = await request(`/api/v1/call/get-livekit-token?room_id=${encodeURIComponent(roomId)}`, 'GET');
        const token = tokenData.token;
        const livekitUrl = tokenData.livekit_url || tokenData.livekitUrl || 'wss://my-app-wsr7to1b.livekit.cloud';

        if (!token) {
            alert("Failed to retrieve LiveKit token.");
            return;
        }

        const LK = window.LivekitClient || window.LiveKit;
        if (!LK) {
            alert("LiveKit Client library not found.");
            return;
        }

        livekitRoom = new LK.Room({
            adaptiveStream: true,
            dynacast: true,
        });

        // Handle incoming tracks dynamically for grid display
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

        livekitRoom.on(LK.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
            try {
                const strData = new TextDecoder().decode(payload);
                const data = JSON.parse(strData);
                const text = (data.text || data.message || "").trim();
                const speaker = data.speaker || data.participantName || (participant ? participant.identity : "Participant");

                if (text) {
                    appendTranscriptSafe(speaker, text);
                    showCaption(speaker, text);
                }
            } catch (err) {
                console.warn("DataReceived parse warning:", err);
            }
        });

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

        // Attach any already existing remote participants/tracks
        livekitRoom.remoteParticipants.forEach(participant => {
            participant.trackPublications.forEach(publication => {
                if (publication.track && publication.isSubscribed) {
                    if (publication.kind === 'video') {
                        let remoteVideo = document.getElementById(`remoteVideo-${participant.identity}`);
                        if (!remoteVideo) {
                            remoteVideo = document.createElement('video');
                            remoteVideo.id = `remoteVideo-${participant.identity}`;
                            remoteVideo.autoplay = true;
                            remoteVideo.playsInline = true;
                            document.querySelector('.video-grid').appendChild(remoteVideo);
                        }
                        publication.track.attach(remoteVideo);
                        remoteVideo.play().catch(e => console.log("Auto-play prevented:", e));
                    }
                }
            });
        });

        startAutoSpeechToText();

    } catch (error) {
        console.error("LiveKit Initialization Exception:", error);
    }
}

function leaveVideoCallSession() {
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
        callWs.close();
        callWs = null;
    }
    endCallSessionUI();
}

function endCallSessionUI() {
    document.getElementById('video-call-section').classList.add('hidden');
    const localVid = document.getElementById("localVideo");
    
    if (localVid) localVid.srcObject = null;
    
    // Clean up dynamically created remote elements
    document.querySelectorAll('[id^="remoteVideo-"], [id^="remoteAudio-"]').forEach(el => el.remove());

    if (currentRoomId || lastRoomId) {
        setTimeout(() => fetchSummary(), 1500);
    }
    currentRoomId = null;
}

function connectCallWebSocket(roomId) {
    if (callWs) callWs.close();

    if (!currentUserId) {
        console.error("Cannot open Call WebSocket: currentUserId is null.");
        return;
    }

    const wsUrl = BASE_URL.replace(/^http/, 'ws');
    callWs = new WebSocket(
        `${wsUrl}/api/v1/call/ws/${encodeURIComponent(roomId)}/${currentUserId}?token=${encodeURIComponent(accessToken)}`
    );

    callWs.onopen = () => {
        console.log(`Connected to call room WS: ${roomId}`);
    };

    callWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const msgType = (data.type || '').toUpperCase();


            // Add inside your active WebSocket message listener switch/if block:
if (msgType === "MESSAGE_SEEN") {
    // data.reader_id has read the messages sent to data.sender_id
    console.log(`Messages seen by user ID: ${data.reader_id}`);
    
    // Update your DOM elements representing message read receipts here
    // e.g., change tick marks from single/gray to double/blue
    document.querySelectorAll(`.message-item[data-sender="${data.sender_id}"] .read-receipt`)
        .forEach(el => {
            el.innerHTML = "✓✓ Seen";
            el.classList.add("text-cyan-400");
        });
}

            if (msgType === "CALL_ENDED_NO_TOKENS") {
                alert(data.message || "Your token balance has run out. The call has been terminated.");
                leaveVideoCallSession();
                fetchNotifications();
                return;
            }

            if (msgType === "BALANCE_UPDATE" || data.current_balance !== undefined) {
                updateWalletDisplay(data.current_balance);
            }

            if (msgType === "TOKEN_DEDUCTION" || msgType === "BALANCE_UPDATE" || data.current_balance !== undefined || data.token_balance !== undefined) {
                const newBalance = data.current_balance !== undefined ? data.current_balance : data.token_balance;
                if (newBalance !== undefined) {
                    updateWalletDisplay(newBalance);
                }
            }

            if (msgType === "LIVE_CAPTION" || msgType === "TRANSCRIPT" || msgType === "LIVEKIT_TRANSCRIPT") {
                const speaker = data.speaker || data.participantName || data.user_email || "Speaker";
                const text = data.text || data.translation || data.original || "";

                if (text) {
                    appendTranscriptSafe(speaker, text);
                    showCaption(speaker, text);
                }
            }
        } catch (err) {
            console.error("Error parsing WebSocket message:", err);
        }
    };

    callWs.onerror = (err) => console.error("Call WebSocket error:", err);
}

async function generateCallSummary() {
    await fetchSummary();
}

async function fetchSummary() {
    const targetRoomId = currentRoomId || lastRoomId;
    if (!targetRoomId) {
        alert("No active or recent call room session found.");
        return;
    }

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
        console.error("Failed to fetch call summary:", e);
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
        if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

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
        // Filter out the read notification from local state and re-render
        unreadNotifications = unreadNotifications.filter(n => n.id !== notificationId);
        updateNotificationUI(unreadNotifications);
    } catch (e) {
        console.error("Failed to mark notification as read:", e);
    }
}
async function handleLogout() {
    try {
        // Leave active video call
        if (typeof leaveVideoCallSession === 'function') {
            await leaveVideoCallSession();
        }
    } catch (error) {
        console.warn('Error leaving video call during logout:', error);
    }

    // Stop subscription/plan refresh timer
    if (plansRefreshTimer) {
        clearInterval(plansRefreshTimer);
        plansRefreshTimer = null;
    }

    // Close chat WebSocket
    try {
        if (typeof chatWs !== 'undefined' && chatWs) {
            if (
                chatWs.readyState === WebSocket.OPEN ||
                chatWs.readyState === WebSocket.CONNECTING
            ) {
                chatWs.close();
            }
        }
    } catch (error) {
        console.warn('Error closing chat WebSocket:', error);
    }

    // Close notification WebSocket
    try {
        if (typeof notifWs !== 'undefined' && notifWs) {
            if (
                notifWs.readyState === WebSocket.OPEN ||
                notifWs.readyState === WebSocket.CONNECTING
            ) {
                notifWs.close();
            }
        }
    } catch (error) {
        console.warn('Error closing notification WebSocket:', error);
    }

    // Reset authentication state
    accessToken = '';
    localStorage.removeItem('access_token');

    currentEmail = '';
    currentUserId = null;

    // Reset call-related state
    if (typeof lastRoomId !== 'undefined') {
        lastRoomId = null;
    }

    // Get screens/elements
    const dashboardScreen = document.getElementById('dashboard-screen');
    const authScreen = document.getElementById('auth-screen');
    const appHeader = document.getElementById('app-header');
    const otpScreen = document.getElementById('otp-screen');
    const chatModal = document.getElementById('chat-modal');

    // Hide dashboard
    if (dashboardScreen) {
        dashboardScreen.classList.add('hidden');
    }

    // Hide application header
    if (appHeader) {
        appHeader.classList.add('hidden');
    }

    // Hide OTP screen
    if (otpScreen) {
        otpScreen.classList.add('hidden');
    }

    // Close chat modal
    if (chatModal) {
        chatModal.classList.add('hidden');
    }

    // Show authentication screen
    if (authScreen) {
        authScreen.classList.remove('hidden');
    }

    // Reset notification UI
    const notifBadge = document.getElementById('notif-badge');
    const notifList = document.getElementById('notif-list');

    if (notifBadge) {
        notifBadge.classList.add('hidden');
        notifBadge.innerText = '0';
    }

    if (notifList) {
        notifList.innerHTML =
            '<p class="empty-msg">No unread notifications</p>';
    }

    console.log('User logged out successfully');
}
// ===================================================================
// WHATSAPP CHAT STATE & FUNCTIONS
// ===================================================================
let activeChatPartnerId = null;
let chatWs = null;
let unreadCounts = {}; // Stores unread counts per friend ID

function initChatWebSocket() {
    if (!currentUserId) return;
    if (chatWs) chatWs.close();

    const wsUrl = BASE_URL.replace(/^http/, 'ws');
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

           if (msgType === "USER_TYPING" || msgType === "USER_STOPPED_TYPING" || data.event === "USER_TYPING" || data.event === "USER_STOPPED_TYPING") {
    const senderId = Number(data.sender_id);
    // Force both to numbers to avoid type mismatch issues (string vs int)
    if (Number(activeChatPartnerId) === senderId) {
        showChatTypingIndicator(
            msgType === "USER_TYPING" || data.event === "USER_TYPING"
        );
    }
    return;
}

            // Handle incoming real-time private message (supports both flat and nested payloads)
            if (msgType === "PRIVATE_MESSAGE" || msgType === "NEW_PRIVATE_MESSAGE" || data.sender_id || data.chat) {
                const chatData = data.chat || data;
                const senderId = Number(chatData.sender_id);
                const messageText = chatData.message;
                const sentAt = chatData.sent_at || new Date().toISOString();
                
                // If the chat modal is currently open with this specific sender, append the message directly
                if (activeChatPartnerId === senderId) {
                    appendChatMessage({
                        sender_id: senderId,
                        receiver_id: currentUserId,
                        message: messageText,
                        sent_at: sentAt,
                        is_read: true
                    });
                    markConversationAsSeen(senderId);
                } else {
                    // Otherwise, increment unread counter badge for the friend card
                    unreadCounts[senderId] = (unreadCounts[senderId] || 0) + 1;
                    updateFriendBadgesUI();
                }

                // If a notification object was included, push it to real-time notifications UI instantly
                if (data.notification) {
                    addRealtimeNotification(data.notification);
                }
            }

            // Handle Read Receipts
            if (msgType === "MESSAGE_SEEN" || data.reader_id) {
                const targetSender = data.sender_id || currentUserId;
                document.querySelectorAll(`.message-item[data-sender="${targetSender}"] .read-receipt`)
                    .forEach(el => {
                        el.innerHTML = "✓✓ Seen";
                        el.classList.add("text-cyan-300");
                    });
            }
        } catch (err) {
            console.warn("Chat WebSocket message warning:", err);
        }
    };

    chatWs.onerror = (err) => console.error("Chat WebSocket error:", err);
    chatWs.onclose = () => {
        setTimeout(initChatWebSocket, 3000);
    };
}


let chatTypingTimeout = null;

function setupChatTypingListener() {
    const input = document.getElementById('chat-message-input');
    if (!input || input.dataset.typingBound) return;
    input.dataset.typingBound = "true";

    // Instantly trigger typing when clicking/focusing the input box
    input.addEventListener('focus', () => {
        if (!activeChatPartnerId || !chatWs || chatWs.readyState !== WebSocket.OPEN) return;
        chatWs.send(JSON.stringify({
            type: "TYPING",
            recipient_id: activeChatPartnerId
        }));
    });

    // Instantly stop typing when clicking outside (blurring the input box)
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
    unreadCounts[friendId] = 0; // Clear unread counter badge
    updateFriendBadgesUI();

    document.getElementById('chat-header-name').innerText = friendName;
    document.getElementById('chat-modal').classList.remove('hidden');

    setupChatTypingListener();

    const messagesBox = document.getElementById('chat-messages-box');
    messagesBox.innerHTML = '<p class="text-center text-slate-500 text-xs my-auto">Loading chat history...</p>';

    try {
        const historyData = await request(`/api/v1/chats/history?id=${friendId}`, 'GET');
        messagesBox.innerHTML = '';

        if (!historyData.messages || historyData.messages.length === 0) {
            messagesBox.innerHTML = '<p class="text-center text-slate-500 text-xs my-auto">No messages yet. Say hello! 👋</p>';
            return;
        }

        historyData.messages.forEach(msg => appendChatMessage(msg));
        
        // Mark conversation as seen upon opening
        await markConversationAsSeen(friendId);
    } catch (e) {
        console.error("Failed to load chat history:", e);
        messagesBox.innerHTML = '<p class="text-center text-rose-400 text-xs my-auto">Failed to load chat history.</p>';
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
                    <span class="w-2 h-2 rounded-full bg-cyan-400 animate-bounce"></span>
                    <span class="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:0.2s]"></span>
                    <span class="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:0.4s]"></span>
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
    document.getElementById('chat-modal').classList.add('hidden');
    activeChatPartnerId = null;
    loadUserDashboard(); // Refresh friends list & badges
}

function appendChatMessage(msg) {
    const messagesBox = document.getElementById('chat-messages-box');
    const emptyMsg = messagesBox.querySelector('.empty-msg');
    if (emptyMsg) emptyMsg.remove();

    const isSent = Number(msg.sender_id) === Number(currentUserId);
    const timeStr = msg.sent_at ? new Date(msg.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Just now';

    const div = document.createElement('div');
    div.className = `flex flex-col message-item ${isSent ? 'items-end' : 'items-start'}`;
    div.setAttribute('data-sender', msg.sender_id);

    div.innerHTML = `
        <div class="message-bubble ${isSent ? 'sent' : 'received'}">
            ${escapeHtml(msg.message)}
            <div class="message-meta">
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
    const message = input.value.trim();

    if (!message || !activeChatPartnerId) return;

    input.value = '';

    try {
        await request('/api/v1/chats/chat/send', 'POST', {
            receiver_id: activeChatPartnerId,
            message: message
        });

        // Optimistically append sent message
        appendChatMessage({
            sender_id: currentUserId,
            receiver_id: activeChatPartnerId,
            message: message,
            sent_at: new Date().toISOString(),
            is_read: false
        });
    } catch (e) {
        console.error("Failed to send message:", e);
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

window.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('access_token');
    if (!token) {
        // Force show login view and do not initialize WebSockets
        document.getElementById('dashboard-view').classList.add('hidden');
        document.getElementById('auth-view').classList.remove('hidden');
        return;
    }
    // Otherwise load dashboard and connect sockets...
});

let selectedDocumentId = null;

async function openDocChatModal() {
    document.getElementById('doc-chat-modal').classList.remove('hidden');
    await loadUserDocumentsDropdown();
}

function closeDocChatModal() {
    document.getElementById('doc-chat-modal').classList.add('hidden');
}

async function loadUserDocumentsDropdown() {
    try {
        const docs = await request('/api/v1/user/documents', 'GET');
        const select = document.getElementById('doc-select-dropdown');
        
        select.innerHTML = '<option value="">-- Select Previous Document --</option>' + 
            docs.map(d => `<option value="${d.document_id}">${escapeHtml(d.document_name)} (${new Date(d.uploaded_at).toLocaleDateString()})</option>`).join('');
    } catch (e) {
        console.error("Failed to load documents:", e);
    }
}

async function onDocumentSelected(docId) {
    selectedDocumentId = docId;
    const input = document.getElementById('doc-question-input');
    const sendBtn = document.getElementById('doc-send-btn');
    const activeLabel = document.getElementById('doc-chat-active-name');

    if (!docId) {
        input.disabled = true;
        sendBtn.disabled = true;
        activeLabel.innerText = "Select a document to start";
        return;
    }

    input.disabled = false;
    sendBtn.disabled = false;
    activeLabel.innerText = "Document ready for questions";

    const select = document.getElementById('doc-select-dropdown');
    const selectedOption = select.options[select.selectedIndex];
    if (selectedOption) {
        activeLabel.innerText = `Active: ${selectedOption.text}`;
    }
}

async function handleModalDocUpload() {
    const fileInput = document.getElementById('modal-doc-upload-input');
    const file = fileInput.files[0];
    if (!file) {
        alert("Please choose a file to upload.");
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const headers = {};
        if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

        const response = await fetch(`${BASE_URL}/api/v1/user/documents/upload`, {
            method: 'POST',
            headers,
            body: formData
        });
        const data = await response.json();

        if (!response.ok) throw new Error(data.detail || 'Upload failed');

        alert("Document uploaded successfully! Processing in background.");
        fileInput.value = '';
        await loadUserDocumentsDropdown();
    } catch (e) {
        console.error("Upload error:", e);
        alert(e.message);
    }
}

async function handleSendDocQuestion(event) {
    event.preventDefault();
    if (!selectedDocumentId) {
        alert("Please select a document first.");
        return;
    }

    const input = document.getElementById('doc-question-input');
    const question = input.value.trim();
    if (!question) return;

    input.value = '';
    const box = document.getElementById('doc-chat-messages-box');
    const emptyMsg = box.querySelector('.empty-msg');
    if (emptyMsg) emptyMsg.remove();

    // Append user message
    box.innerHTML += `
        <div class="flex justify-end">
            <div class="bg-cyan-500 text-slate-950 rounded-2xl px-4 py-2.5 max-w-[80%] text-sm font-medium shadow-md">
                ${escapeHtml(question)}
            </div>
        </div>
    `;

    // Append 3-dot typing loader
    const loaderId = 'loader-' + Date.now();
    box.innerHTML += `
        <div id="${loaderId}" class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-cyan-400 text-xs font-bold">AI</div>
            <div class="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-slate-400 flex items-center gap-1.5 shadow-md">
                <span class="w-2 h-2 rounded-full bg-cyan-400 animate-bounce"></span>
                <span class="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:0.2s]"></span>
                <span class="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:0.4s]"></span>
            </div>
        </div>
    `;
    box.scrollTop = box.scrollHeight;

    try {
        const res = await request(`/api/v1/user/documents/${selectedDocumentId}/ask?question=${encodeURIComponent(question)}`, 'POST');
        
        // Remove loader
        document.getElementById(loaderId).remove();

        // Format structured response
        const formattedAnswer = escapeHtml(res.answer || "No response generated.")
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        box.innerHTML += `
            <div class="flex items-start gap-2">
                <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-cyan-400 text-xs font-bold shrink-0">AI</div>
                <div class="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-slate-200 text-sm shadow-md space-y-2 max-w-[85%]">
                    <div class="leading-relaxed">${formattedAnswer}</div>
                </div>
            </div>
        `;
        box.scrollTop = box.scrollHeight;
    } catch (e) {
        document.getElementById(loaderId).remove();
        box.innerHTML += `
            <div class="text-rose-400 text-xs p-2">Failed to get response from document.</div>
        `;
        box.scrollTop = box.scrollHeight;
    }
}
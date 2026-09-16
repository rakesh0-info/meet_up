const BASE_URL = 'http://127.0.0.1:8000';
let accessToken = '';
let currentEmail = '';
let currentUserRole = '';
let currentUserId = null;
let notifWs = null;
let callWs = null;
let currentRoomId = null;
let lastRoomId = null;
let livekitRoom = null;

let activeTranscripts = [];

// Web Speech API auto-transcription engine
let speechRecognizer = null;

function startAutoSpeechToText() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn("Web Speech API is not supported in this browser.");
        return;
    }

    if (speechRecognizer) {
        try { speechRecognizer.stop(); } catch(e){}
    }

    speechRecognizer = new SpeechRecognition();
    speechRecognizer.continuous = true;
    speechRecognizer.interimResults = false;
    speechRecognizer.lang = 'en-US';

    speechRecognizer.onresult = (event) => {
        const lastResultIndex = event.results.length - 1;
        const transcriptText = event.results[lastResultIndex][0].transcript.trim();

        if (transcriptText) {
            const speaker = currentEmail || "Participant";

            // 1. Broadcast over WebSocket to active backend call room
            if (callWs && callWs.readyState === WebSocket.OPEN) {
                callWs.send(JSON.stringify({
                    type: "LIVEKIT_TRANSCRIPT",
                    text: transcriptText,
                    participantName: speaker,
                    timestamp: Date.now()
                }));
            }

            // 2. Broadcast over LiveKit Data Channel
            if (livekitRoom && livekitRoom.localParticipant) {
                try {
                    const payload = new TextEncoder().encode(JSON.stringify({
                        type: "TRANSCRIPT",
                        text: transcriptText,
                        speaker: speaker,
                        timestamp: Date.now()
                    }));
                    livekitRoom.localParticipant.publishData(payload, { reliable: true });
                } catch (e) {
                    console.warn("LiveKit publishData error:", e);
                }
            }

            // 3. Render directly onto local UI
            appendTranscript(speaker, transcriptText);
            showCaption(speaker, transcriptText);
        }
    };

    speechRecognizer.onerror = (event) => {
        console.warn("Speech Recognition Warning:", event.error);
    };

    speechRecognizer.onend = () => {
        if (livekitRoom) {
            try { speechRecognizer.start(); } catch(e){}
        }
    };

    try {
        speechRecognizer.start();
        console.log("Auto Speech-to-Text activated successfully.");
    } catch (e) {
        console.error("Failed to start speech recognition:", e);
    }
}

function stopAutoSpeechToText() {
    if (speechRecognizer) {
        try { speechRecognizer.stop(); } catch(e){}
        speechRecognizer = null;
    }
}

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

    document.getElementById('greeting-text').innerText = `Welcome, ${currentEmail}`;
    document.getElementById('role-badge').innerText = currentUserRole.toUpperCase();

    if (currentUserRole.toLowerCase() === 'admin') {
        await loadAdminDashboard();
    } else {
        await loadUserDashboard();
    }

    fetchSubscriptions();
    fetchNotifications();
    initNotificationWebSocket();
}

async function loadAdminDashboard() {
    document.getElementById('admin-summary-section').classList.remove('hidden');
    try {
        const adminData = await request('/api/v1/admin/get_all_user', 'GET');
        
        const me = adminData.users.find(u => u.email === currentEmail);
        if (me) {
            currentUserId = me.user_id;
            updateWalletDisplay(me.current_token_balance);
        }

        document.getElementById('admin-usage-card').innerHTML = `
            <p><strong>Analytics Date:</strong> ${adminData.today_summary.date}</p>
            <p><strong>Tokens Consumed Today:</strong> ${adminData.today_summary.total_tokens_consumed_today}</p>
            <p><strong>Total Call Duration Today:</strong> ${adminData.today_summary.total_duration_seconds_today} seconds</p>
            <p><strong>Total System Users:</strong> ${adminData.total_users_count}</p>
        `;

        const usersGrid = document.getElementById('users-grid');
        const otherUsers = adminData.users.filter(u => u.email !== currentEmail);

        usersGrid.innerHTML = otherUsers.map(u => `
            <div class="item-card">
                <h3>${u.email}</h3>
                <p><strong>Role:</strong> ${u.role}</p>
                <p><strong>Wallet Balance:</strong> ${u.current_token_balance} Tokens</p>
                <p><strong>Total Tokens Used:</strong> ${u.total_tokens_used}</p>
                <p><strong>Total Calls:</strong> ${u.total_calls_count}</p>
            </div>
        `).join('');

    } catch (e) {
        console.error("Error loading admin dashboard", e);
    }
}

async function loadUserDashboard() {
    document.getElementById('admin-summary-section').classList.add('hidden');
    try {
        const users = await request('/api/v1/user/users', 'GET');
        
        const me = users.find(u => u.email === currentEmail);
        if (me) {
            currentUserId = me.id;
            updateWalletDisplay(me.token_balance || 0);
        }

        const otherUsers = users.filter(u => {
            const isSelf = u.email === currentEmail || u.id === currentUserId;
            const isAdmin = u.role && u.role.toString().toLowerCase().includes('admin');
            return !isSelf && !isAdmin;
        });

        const usersGrid = document.getElementById('users-grid');
        usersGrid.innerHTML = otherUsers.map(u => `
            <div class="item-card">
                <h3>${u.name || u.email}</h3>
                <p><strong>Email:</strong> ${u.email}</p>
                <div style="display: flex; gap: 8px; margin-top: 5px;">
                    <button onclick="sendFriendRequest(${u.id})">Add Friend</button>
                    <button class="btn-success" onclick="initiateCall(${u.id})">Call User</button>
                </div>
            </div>
        `).join('');

    } catch (e) {
        console.error("Error loading user dashboard", e);
    }
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
                <p><strong>Price:</strong> ${p.amount_to_pay} ${p.currency.toUpperCase()}</p>
                ${currentUserRole.toLowerCase() === 'user' ? `<button onclick="subscribePlan(${p.id})">Buy Tokens</button>` : ''}
            </div>
        `).join('');
    } catch (e) {
        console.error(e);
    }
}

async function subscribePlan(planId) {
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

async function fetchNotifications() {
    try {
        const unread = await request('/api/v1/notifications/unread', 'GET');
        updateNotificationUI(unread);
    } catch (e) {
        console.error(e);
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
        let senderId = n.sender_id || n.metadata?.sender_id || n.data?.sender_id;
        let roomId = n.room_id || n.metadata?.room_id || n.data?.room_id || n.roomId;
        const msg = (n.message || '').toString();

        if (!roomId) {
            const uuidMatch = msg.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (uuidMatch) roomId = uuidMatch[0];
        }

        if (roomId) lastRoomId = roomId;

        const isIncomingCall = n.notification_type === 'INCOMING_CALL' || (msg.toLowerCase().includes('incoming') && msg.toLowerCase().includes('call'));
        const isSummaryNotif = n.notification_type === 'CALL_SUMMARY_READY' || msg.toLowerCase().includes('summary');
        const isFriendReq = n.notification_type === 'FRIEND_REQUEST' || (msg.toLowerCase().includes('friend') && msg.toLowerCase().includes('request'));

        return `
            <div class="notif-item">
                <p>${msg}</p>
                ${(isFriendReq && senderId) ? `
                    <div class="notif-actions">
                        <button class="btn-success" onclick="respondRequest(${senderId}, 'yes', ${n.id})">Accept</button>
                        <button class="btn-danger" onclick="respondRequest(${senderId}, 'no', ${n.id})">Reject</button>
                    </div>
                ` : ''}
                ${(isIncomingCall) ? `
                    <div class="notif-actions">
                        <button class="btn-success" onclick="respondToCall('${roomId || ''}', true, ${n.id})">Accept Call</button>
                        <button class="btn-danger" onclick="respondToCall('${roomId || ''}', false, ${n.id})">Reject</button>
                    </div>
                ` : ''}
                ${(isSummaryNotif) ? `
                    <div class="notif-actions">
                        <button class="btn-success" onclick="viewSummaryFromNotif('${roomId || ''}', ${n.id})">View Summary</button>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
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

function initNotificationWebSocket() {
    if (!currentUserId) return;
    if (notifWs) notifWs.close();

    const wsUrl = BASE_URL.replace(/^http/, 'ws');
    notifWs = new WebSocket(`${wsUrl}/api/v1/notifications/ws/${currentUserId}?token=${accessToken}`);

    notifWs.onmessage = () => {
        fetchNotifications();
    };

    notifWs.onerror = (err) => {
        console.error("Notification WebSocket error:", err);
    };
}

async function initiateCall(receiverId) {
    try {
        const res = await request('/api/v1/call/request_call', 'POST', { receiver_id: receiverId });
        alert(`Call requested successfully! Room ID: ${res.room_id}`);
        currentRoomId = res.room_id;
        lastRoomId = res.room_id;
        await openCallUI(res.room_id);
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
            alert("LiveKit Client library not found. Please include livekit-client.umd.min.js CDN in your HTML.");
            return;
        }

        livekitRoom = new LK.Room({
            adaptiveStream: true,
            dynacast: true,
        });

        livekitRoom.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'video') {
                const remoteVideo = document.getElementById("remoteVideo");
                if (remoteVideo) track.attach(remoteVideo);
            } else if (track.kind === 'audio') {
                let remoteAudio = document.getElementById("remoteAudio");
                if (!remoteAudio) {
                    remoteAudio = document.createElement("audio");
                    remoteAudio.id = "remoteAudio";
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
                    appendTranscript(speaker, text);
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

        await livekitRoom.localParticipant.enableCameraAndMicrophone();

        const videoPubs = Array.from(livekitRoom.localParticipant.videoTrackPublications.values());
        if (videoPubs.length > 0 && videoPubs[0].track) {
            const localVideo = document.getElementById("localVideo");
            if (localVideo) videoPubs[0].track.attach(localVideo);
        }

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
    const remoteVid = document.getElementById("remoteVideo");
    
    if (localVid) localVid.srcObject = null;
    if (remoteVid) remoteVid.srcObject = null;

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
    callWs = new WebSocket(`${wsUrl}/api/v1/call/ws/${roomId}/${currentUserId}`);

    callWs.onopen = () => {
        console.log(`Connected to call room WS: ${roomId}`);
    };

    callWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const msgType = (data.type || '').toUpperCase();

            if (msgType === "LIVE_CAPTION" || msgType === "TRANSCRIPT" || msgType === "LIVEKIT_TRANSCRIPT") {
                const speaker = data.speaker || data.participantName || data.user_email || "Speaker";
                const text = data.text || data.translation || data.original || "";

                if (text) {
                    appendTranscript(speaker, text);
                    showCaption(speaker, text);
                }
            }
        } catch (err) {
            console.error("Error parsing WebSocket message:", err);
        }
    };

    callWs.onerror = (err) => console.error("Call WebSocket error:", err);
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

    if (callWs && callWs.readyState === WebSocket.OPEN) {
        callWs.send(JSON.stringify({
            type: "LIVEKIT_TRANSCRIPT",
            text: text,
            participantName: speaker,
            timestamp: Date.now()
        }));
    }

    if (livekitRoom && livekitRoom.localParticipant) {
        try {
            const payload = new TextEncoder().encode(JSON.stringify({
                type: "TRANSCRIPT",
                text: text,
                speaker: speaker,
                timestamp: Date.now()
            }));
            livekitRoom.localParticipant.publishData(payload, { reliable: true });
        } catch (err) {
            console.warn("LiveKit publishData error:", err);
        }
    }

    appendTranscript(speaker, text);
    showCaption(speaker, text);

    if (speechInput) speechInput.value = '';
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

function handleLogout() {
    leaveVideoCallSession();
    accessToken = '';
    currentEmail = '';
    currentUserId = null;
    if (notifWs) notifWs.close();
    location.reload();
}
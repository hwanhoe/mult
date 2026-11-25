(function () {
  const ROUND_SECONDS = 60;
  const CANVAS_W = 800;
  const CANVAS_H = 540;

  // 탭마다 고유한 플레이어 ID 생성 (같은 PC에서 탭 2개로 테스트 가능)
  let playerId = sessionStorage.getItem('sketch_player_id');
  if (!playerId) {
    playerId = 'p_' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('sketch_player_id', playerId);
  }

  // 상태
  const state = {
    supabase: null,
    isConfigured: false,
    practiceMode: false,
    soundEnabled: true,
    avatar: '🐶',
    nickname: '',
    roomCode: '',
    room: null,
    players: [],
    channel: null,
    pollTimer: null,
    countdownTimer: null,
    lastRoundRendered: 0,
    roundLocked: false,
    usedWords: [],
    // 그리기 상태
    drawing: false,
    lastPt: null,
    brushColor: '#1e293b',
    brushSize: 9,
    strokeQueue: [],
    flushTimer: null,
  };

  // DOM 요소
  const $ = (id) => document.getElementById(id);
  const screens = {
    lobby: $('screen-lobby'),
    waiting: $('screen-waiting'),
    game: $('screen-game'),
    result: $('screen-result'),
  };

  const canvas = $('draw-canvas');
  const ctx = canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Web Audio API 간단 효과음
  let audioCtx = null;
  function playTone(freq, duration, type = 'sine', delay = 0) {
    if (!state.soundEnabled) return;
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const now = audioCtx.currentTime + delay;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + duration);
    } catch (_) {}
  }

  function playCorrectSound() {
    playTone(523.25, 0.12, 'triangle', 0);
    playTone(659.25, 0.12, 'triangle', 0.1);
    playTone(783.99, 0.25, 'triangle', 0.2);
  }

  function playStartSound() {
    playTone(440, 0.1, 'sine', 0);
    playTone(587.33, 0.18, 'sine', 0.1);
  }

  // 화면 전환
  function showScreen(name) {
    Object.keys(screens).forEach((k) => {
      screens[k].classList.toggle('active', k === name);
    });
  }

  function showLobbyError(msg) {
    const el = $('lobby-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function clearLobbyError() {
    $('lobby-error').classList.add('hidden');
  }

  // 초기화
  function init() {
    const cfg = window.GAME_CONFIG || {};
    const url = (cfg.SUPABASE_URL || '').trim();
    const key = (cfg.SUPABASE_ANON_KEY || '').trim();

    if (url && key && window.supabase) {
      state.supabase = window.supabase.createClient(url, key);
      state.isConfigured = true;
      $('conn-badge').textContent = '온라인 준비됨';
      $('conn-badge').className = 'badge badge-online';
      $('setup-banner').classList.add('hidden');
    } else {
      state.isConfigured = false;
      $('conn-badge').textContent = '연결 전 (연습 가능)';
      $('conn-badge').className = 'badge badge-offline';
      $('setup-banner').classList.remove('hidden');
    }

    // URL ?room=1234 자동 채우기
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam && /^\d{4}$/.test(roomParam)) {
      $('room-code-input').value = roomParam;
    }

    // 저장된 닉네임 복원
    const savedName = localStorage.getItem('sketch_nickname');
    if (savedName) $('nickname-input').value = savedName;

    bindEvents();
  }

  function bindEvents() {
    // 효과음 토글
    $('sound-toggle').addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      $('sound-toggle').textContent = state.soundEnabled ? '🔊' : '🔇';
    });

    // 아바타 선택
    $('avatar-picker').addEventListener('click', (e) => {
      const btn = e.target.closest('.avatar-btn');
      if (!btn) return;
      document.querySelectorAll('.avatar-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.avatar = btn.dataset.avatar;
    });

    // 방 만들기 / 들어가기 / 연습
    $('create-room-btn').addEventListener('click', handleCreateRoom);
    $('join-room-btn').addEventListener('click', handleJoinRoom);
    $('practice-btn').addEventListener('click', startPracticeMode);

    // 대기실
    $('copy-code-btn').addEventListener('click', () => copyText(state.roomCode, $('copy-code-btn'), '복사됨!'));
    $('copy-link-btn').addEventListener('click', () => {
      const link = `${location.origin}${location.pathname}?room=${state.roomCode}`;
      copyText(link, $('copy-link-btn'), '링크 복사됨!');
    });
    $('start-game-btn').addEventListener('click', handleStartGame);
    $('leave-waiting-btn').addEventListener('click', leaveRoom);

    // 게임 화면
    $('exit-game-btn').addEventListener('click', leaveRoom);
    $('clear-canvas-btn').addEventListener('click', () => {
      if (!canDraw()) return;
      clearCanvas();
      if (!state.practiceMode && state.channel) {
        state.channel.send({ type: 'broadcast', event: 'clear', payload: {} });
      }
    });

    // 색상 팔레트
    $('color-palette').addEventListener('click', (e) => {
      const dot = e.target.closest('.color-dot');
      if (!dot) return;
      document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('selected'));
      dot.classList.add('selected');
      state.brushColor = dot.dataset.color;
    });

    // 굵기 선택
    document.querySelectorAll('.size-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.size-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.brushSize = Number(btn.dataset.size);
      });
    });

    // 채팅 / 정답 입력
    $('chat-form').addEventListener('submit', handleChatSubmit);

    // 결과 화면
    $('play-again-btn').addEventListener('click', handlePlayAgain);
    $('back-to-lobby-btn').addEventListener('click', leaveRoom);

    // 캔버스 포인터 이벤트 (마우스 + 터치 통합)
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function copyText(text, btn, doneLabel) {
    const orig = btn.textContent;
    navigator.clipboard?.writeText(text).then(() => {
      btn.textContent = doneLabel;
      setTimeout(() => (btn.textContent = orig), 1500);
    }).catch(() => {});
  }

  function getNickname() {
    const name = $('nickname-input').value.trim();
    if (!name) {
      showLobbyError('닉네임을 먼저 입력해 주세요!');
      $('nickname-input').focus();
      return null;
    }
    localStorage.setItem('sketch_nickname', name);
    state.nickname = name;
    return name;
  }

  function pickRandomWord() {
    const words = window.GAME_WORDS || ['사과', '강아지', '자동차'];
    const available = words.filter((w) => !state.usedWords.includes(w));
    const pool = available.length > 0 ? available : words;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    state.usedWords.push(picked);
    return picked;
  }

  // ---------------- 혼자 연습 모드 ----------------
  function startPracticeMode() {
    clearLobbyError();
    state.practiceMode = true;
    state.room = null;
    clearCanvas();
    showScreen('game');
    $('round-badge').textContent = '연습 모드';
    $('timer-badge').textContent = '⏱️ 자유 시간';
    $('timer-badge').classList.remove('urgent');
    $('word-label').textContent = '추천 제시어';
    $('word-text').textContent = pickRandomWord();
    $('draw-tools').classList.remove('disabled');
    $('side-panel').classList.add('hidden');
    $('round-overlay').classList.add('hidden');

    // 제시어 배너 클릭 시 새 단어 뽑기
    $('word-banner').style.cursor = 'pointer';
    $('word-banner').title = '클릭하면 다른 제시어로 바뀌어요!';
    $('word-banner').onclick = () => {
      if (state.practiceMode) {
        $('word-text').textContent = pickRandomWord();
        clearCanvas();
      }
    };
  }

  // ---------------- 방 생성 / 입장 ----------------
  async function handleCreateRoom() {
    clearLobbyError();
    if (!state.isConfigured) {
      showLobbyError('먼저 가이드에 따라 Supabase를 연결해야 멀티플레이 방을 만들 수 있어요!');
      return;
    }
    const name = getNickname();
    if (!name) return;

    const code = String(Math.floor(1000 + Math.random() * 9000));
    const { error: roomErr } = await state.supabase.from('rooms').insert({
      code,
      host_id: playerId,
      status: 'waiting',
      current_round: 0,
      total_rounds: 5,
    });

    if (roomErr) {
      showLobbyError('방을 만들지 못했어요: ' + roomErr.message);
      return;
    }

    const { error: playerErr } = await state.supabase.from('players').insert({
      id: playerId,
      room_code: code,
      name,
      avatar: state.avatar,
      score: 0,
      is_host: true,
    });

    if (playerErr) {
      showLobbyError('방 입장에 실패했어요: ' + playerErr.message);
      return;
    }

    await enterRoom(code);
  }

  async function handleJoinRoom() {
    clearLobbyError();
    if (!state.isConfigured) {
      showLobbyError('먼저 가이드에 따라 Supabase를 연결해야 방에 들어갈 수 있어요!');
      return;
    }
    const name = getNickname();
    if (!name) return;

    const code = $('room-code-input').value.trim();
    if (!/^\d{4}$/.test(code)) {
      showLobbyError('4자리 숫자 방 코드를 입력해 주세요!');
      return;
    }

    const { data: roomData, error: findErr } = await state.supabase
      .from('rooms')
      .select('*')
      .eq('code', code)
      .maybeSingle();

    if (findErr || !roomData) {
      showLobbyError('해당 방을 찾을 수 없어요. 코드를 다시 확인해 주세요!');
      return;
    }

    const { error: joinErr } = await state.supabase.from('players').upsert({
      id: playerId,
      room_code: code,
      name,
      avatar: state.avatar,
      score: 0,
      is_host: roomData.host_id === playerId,
    });

    if (joinErr) {
      showLobbyError('방에 들어가지 못했어요: ' + joinErr.message);
      return;
    }

    await enterRoom(code);
  }

  async function enterRoom(code) {
    state.practiceMode = false;
    state.roomCode = code;
    state.lastRoundRendered = 0;
    state.roundLocked = false;
    $('side-panel').classList.remove('hidden');
    $('word-banner').style.cursor = 'default';
    $('word-banner').onclick = null;
    $('chat-messages').innerHTML = '';

    await fetchRoomState();
    subscribeRoom(code);

    // 실시간 누락 대비 3초마다 상태 동기화
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(fetchRoomState, 3000);
  }

  async function fetchRoomState() {
    if (!state.roomCode || !state.supabase) return;
    const [roomRes, playersRes] = await Promise.all([
      state.supabase.from('rooms').select('*').eq('code', state.roomCode).maybeSingle(),
      state.supabase.from('players').select('*').eq('room_code', state.roomCode).order('joined_at', { ascending: true }),
    ]);

    if (roomRes.data) {
      state.room = roomRes.data;
    }
    if (playersRes.data) {
      state.players = playersRes.data;
    }
    renderRoomState();
  }

  function subscribeRoom(code) {
    if (state.channel) {
      state.supabase.removeChannel(state.channel);
    }

    const ch = state.supabase.channel('room:' + code, {
      config: { broadcast: { self: false } },
    });

    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'rooms', filter: `code=eq.${code}` },
      (payload) => {
        if (payload.new) {
          state.room = payload.new;
          renderRoomState();
        }
      }
    );

    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'players', filter: `room_code=eq.${code}` },
      () => {
        fetchRoomState();
      }
    );

    ch.on('broadcast', { event: 'draw' }, ({ payload }) => {
      if (payload && Array.isArray(payload.segments)) {
        payload.segments.forEach((seg) => drawSegment(seg.x0, seg.y0, seg.x1, seg.y1, seg.color, seg.size));
      }
    });

    ch.on('broadcast', { event: 'clear' }, () => {
      clearCanvas();
    });

    ch.on('broadcast', { event: 'chat' }, ({ payload }) => {
      if (!payload) return;
      appendChat(`${payload.avatar} ${payload.name}: ${payload.text}`);
    });

    ch.on('broadcast', { event: 'correct_guess' }, ({ payload }) => {
      if (!payload) return;
      onCorrectGuessReceived(payload);
    });

    ch.subscribe();
    state.channel = ch;
  }

  async function leaveRoom() {
    clearInterval(state.pollTimer);
    clearInterval(state.countdownTimer);
    if (state.channel && state.supabase) {
      state.supabase.removeChannel(state.channel);
      state.channel = null;
    }
    if (state.roomCode && state.supabase && !state.practiceMode) {
      await state.supabase
        .from('players')
        .delete()
        .eq('room_code', state.roomCode)
        .eq('id', playerId);
    }
    state.practiceMode = false;
    state.roomCode = '';
    state.room = null;
    state.players = [];
    showScreen('lobby');
  }

  // ---------------- 방 상태 렌더링 ----------------
  function isHost() {
    return state.room && state.room.host_id === playerId;
  }

  function isDrawer() {
    return state.room && state.room.drawer_id === playerId;
  }

  function canDraw() {
    if (state.practiceMode) return true;
    return state.room && state.room.status === 'playing' && isDrawer() && !state.roundLocked;
  }

  function renderRoomState() {
    const room = state.room;
    if (!room) return;

    if (room.status === 'waiting') {
      showScreen('waiting');
      $('waiting-room-code').textContent = room.code;
      $('waiting-player-count').textContent = state.players.length;

      const list = $('waiting-player-list');
      list.innerHTML = '';
      state.players.forEach((p) => {
        const li = document.createElement('li');
        li.className = 'player-chip';
        const crown = p.id === room.host_id ? ' 👑' : '';
        li.innerHTML = `<span class="avatar">${p.avatar}</span><span class="name">${escapeHtml(p.name)}${crown}</span>`;
        list.appendChild(li);
      });

      $('host-controls').classList.toggle('hidden', !isHost());
      $('guest-waiting-msg').classList.toggle('hidden', isHost());
      clearInterval(state.countdownTimer);
      return;
    }

    if (room.status === 'playing') {
      showScreen('game');
      $('round-badge').textContent = `${room.current_round} / ${room.total_rounds} 라운드`;

      // 새 라운드가 시작되었을 때 초기화
      if (state.lastRoundRendered !== room.current_round) {
        state.lastRoundRendered = room.current_round;
        state.roundLocked = false;
        clearCanvas();
        $('round-overlay').classList.add('hidden');
        playStartSound();

        const drawer = state.players.find((p) => p.id === room.drawer_id);
        const drawerName = drawer ? `${drawer.avatar} ${drawer.name}` : '친구';
        appendChat(`🎨 ${room.current_round}라운드 시작! 출제자: ${drawerName}`, 'system');
      }

      // 제시어 표시
      if (isDrawer()) {
        $('word-label').textContent = '그릴 제시어';
        $('word-text').textContent = room.current_word || '';
        $('draw-tools').classList.remove('disabled');
        $('chat-input').disabled = true;
        $('chat-input').placeholder = '출제자는 그림을 그려주세요!';
        $('chat-send-btn').disabled = true;
      } else {
        const len = (room.current_word || '').length;
        $('word-label').textContent = '정답 맞히기';
        $('word-text').textContent = `${'◯'.repeat(len)} (${len}글자)`;
        $('draw-tools').classList.add('disabled');
        $('chat-input').disabled = false;
        $('chat-input').placeholder = '정답을 입력해 보세요!';
        $('chat-send-btn').disabled = false;
      }

      renderScoreboard();
      startCountdown();
      return;
    }

    if (room.status === 'finished') {
      clearInterval(state.countdownTimer);
      showScreen('result');
      const sorted = [...state.players].sort((a, b) => b.score - a.score);
      const medals = ['🥇', '🥈', '🥉'];
      const podium = $('result-podium');
      podium.innerHTML = '';
      sorted.forEach((p, idx) => {
        const li = document.createElement('li');
        li.className = 'podium-item';
        const rank = medals[idx] || `${idx + 1}위`;
        li.innerHTML = `<span>${rank} ${p.avatar} ${escapeHtml(p.name)}</span><span>${p.score}점</span>`;
        podium.appendChild(li);
      });
      $('play-again-btn').classList.toggle('hidden', !isHost());
    }
  }

  function renderScoreboard() {
    const list = $('game-scoreboard');
    list.innerHTML = '';
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    sorted.forEach((p) => {
      const li = document.createElement('li');
      const drawingNow = state.room && state.room.drawer_id === p.id;
      li.className = 'score-item' + (drawingNow ? ' is-drawer' : '');
      li.innerHTML = `
        <span class="score-left">${p.avatar} ${escapeHtml(p.name)} ${drawingNow ? '✏️' : ''}</span>
        <span class="score-pts">${p.score}점</span>
      `;
      list.appendChild(li);
    });
  }

  // ---------------- 게임 진행 (방장 제어) ----------------
  async function handleStartGame() {
    if (!isHost() || state.players.length === 0) return;
    const totalRounds = Number($('round-count-select').value) || 5;
    state.usedWords = [];

    // 점수 초기화
    await state.supabase
      .from('players')
      .update({ score: 0 })
      .eq('room_code', state.roomCode);

    await startRound(1, totalRounds);
  }

  async function handlePlayAgain() {
    if (!isHost()) return;
    await state.supabase
      .from('rooms')
      .update({ status: 'waiting', current_round: 0, drawer_id: null, current_word: null })
      .eq('code', state.roomCode);
  }

  async function startRound(roundNum, totalRounds) {
    if (!isHost()) return;
    const players = state.players;
    if (players.length === 0) return;

    const drawer = players[(roundNum - 1) % players.length];
    const word = pickRandomWord();
    const endsAt = new Date(Date.now() + ROUND_SECONDS * 1000).toISOString();

    await state.supabase
      .from('rooms')
      .update({
        status: 'playing',
        current_round: roundNum,
        total_rounds: totalRounds,
        drawer_id: drawer.id,
        current_word: word,
        round_ends_at: endsAt,
      })
      .eq('code', state.roomCode);
  }

  function startCountdown() {
    clearInterval(state.countdownTimer);
    const update = () => {
      if (!state.room || !state.room.round_ends_at) return;
      const diff = Math.max(0, Math.ceil((new Date(state.room.round_ends_at).getTime() - Date.now()) / 1000));
      const badge = $('timer-badge');
      badge.textContent = `⏱️ ${diff}초`;
      badge.classList.toggle('urgent', diff <= 10);

      if (diff <= 0 && !state.roundLocked) {
        state.roundLocked = true;
        showRoundOverlay('⏰', '시간 끝!', `정답은 "${state.room.current_word}" 이었어요!`);
        if (isHost()) {
          setTimeout(advanceAfterRound, 2600);
        }
      }
    };
    update();
    state.countdownTimer = setInterval(update, 500);
  }

  async function advanceAfterRound() {
    if (!isHost() || !state.room) return;
    const next = state.room.current_round + 1;
    if (next > state.room.total_rounds) {
      await state.supabase
        .from('rooms')
        .update({ status: 'finished' })
        .eq('code', state.roomCode);
    } else {
      await startRound(next, state.room.total_rounds);
    }
  }

  // ---------------- 채팅 및 정답 처리 ----------------
  async function handleChatSubmit(e) {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !state.room || state.room.status !== 'playing') return;
    input.value = '';

    if (isDrawer() || state.roundLocked) return;

    const answer = (state.room.current_word || '').trim();
    if (text === answer) {
      state.roundLocked = true;
      // 내 점수 +10점
      const me = state.players.find((p) => p.id === playerId);
      const newScore = (me ? me.score : 0) + 10;
      await state.supabase
        .from('players')
        .update({ score: newScore })
        .eq('room_code', state.roomCode)
        .eq('id', playerId);

      const payload = {
        playerId,
        name: state.nickname,
        avatar: state.avatar,
        word: answer,
      };

      if (state.channel) {
        state.channel.send({ type: 'broadcast', event: 'correct_guess', payload });
      }
      onCorrectGuessReceived(payload);
    } else {
      appendChat(`${state.avatar} ${state.nickname}: ${text}`);
      if (state.channel) {
        state.channel.send({
          type: 'broadcast',
          event: 'chat',
          payload: { name: state.nickname, avatar: state.avatar, text },
        });
      }
    }
  }

  async function onCorrectGuessReceived(payload) {
    state.roundLocked = true;
    playCorrectSound();
    appendChat(`🎉 ${payload.avatar} ${payload.name}님이 정답 "${payload.word}"을(를) 맞혔어요! (+10점)`, 'correct');
    showRoundOverlay('🎉', `${payload.avatar} ${payload.name}님 정답!`, `정답은 "${payload.word}"!`);

    // 방장이 출제자 보너스(+5점) 반영 후 다음 라운드로
    if (isHost() && state.room) {
      const drawer = state.players.find((p) => p.id === state.room.drawer_id);
      if (drawer && drawer.id !== payload.playerId) {
        await state.supabase
          .from('players')
          .update({ score: drawer.score + 5 })
          .eq('room_code', state.roomCode)
          .eq('id', drawer.id);
      }
      setTimeout(advanceAfterRound, 2600);
    }
  }

  function showRoundOverlay(emoji, title, desc) {
    $('overlay-emoji').textContent = emoji;
    $('overlay-title').textContent = title;
    $('overlay-desc').textContent = desc;
    $('round-overlay').classList.remove('hidden');
  }

  function appendChat(text, type = '') {
    const box = $('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-msg' + (type ? ' ' + type : '');
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  // ---------------- 캔버스 그리기 ----------------
  function getNormPoint(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  }

  function onPointerDown(e) {
    if (!canDraw()) return;
    e.preventDefault();
    state.drawing = true;
    state.lastPt = getNormPoint(e);
    // 점 하나 찍기
    drawSegment(state.lastPt.x, state.lastPt.y, state.lastPt.x, state.lastPt.y, state.brushColor, state.brushSize);
    queueSegment(state.lastPt.x, state.lastPt.y, state.lastPt.x, state.lastPt.y, state.brushColor, state.brushSize);
  }

  function onPointerMove(e) {
    if (!state.drawing || !canDraw()) return;
    e.preventDefault();
    const pt = getNormPoint(e);
    drawSegment(state.lastPt.x, state.lastPt.y, pt.x, pt.y, state.brushColor, state.brushSize);
    queueSegment(state.lastPt.x, state.lastPt.y, pt.x, pt.y, state.brushColor, state.brushSize);
    state.lastPt = pt;
  }

  function onPointerUp() {
    if (!state.drawing) return;
    state.drawing = false;
    state.lastPt = null;
    flushSegments();
  }

  function drawSegment(x0, y0, x1, y1, color, size) {
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.beginPath();
    ctx.moveTo(x0 * CANVAS_W, y0 * CANVAS_H);
    ctx.lineTo(x1 * CANVAS_W, y1 * CANVAS_H);
    ctx.stroke();
  }

  function queueSegment(x0, y0, x1, y1, color, size) {
    if (state.practiceMode || !state.channel) return;
    state.strokeQueue.push({ x0, y0, x1, y1, color, size });
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(flushSegments, 25);
    }
  }

  function flushSegments() {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
    if (state.strokeQueue.length === 0 || !state.channel) return;
    const segments = state.strokeQueue.splice(0, state.strokeQueue.length);
    state.channel.send({ type: 'broadcast', event: 'draw', payload: { segments } });
  }

  function clearCanvas() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  init();
})();

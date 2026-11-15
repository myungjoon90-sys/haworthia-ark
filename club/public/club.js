// 하월시아 클럽 — 화면 동작 (좋아요·댓글·사진 올리기·# 자동완성·로그인·운영자)
(function () {
  var B = document.documentElement.getAttribute('data-b') || '';
  var LOGGED = document.documentElement.getAttribute('data-me') === '1';

  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function toast(msg) {
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }
  window.clubToast = toast;
  function api(url, body) {
    return fetch(B + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}), credentials: 'same-origin',
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: '서버 응답 오류' }; }); });
  }
  window.clubApi = api;
  function needLogin() {
    if (LOGGED) return false;
    location.href = B + '/login?next=' + encodeURIComponent(location.pathname + location.search);
    return true;
  }

  // ---- 사진 넘기기 점 ----
  function bindStrips(root) {
    $$('.ph .strip', root).forEach(function (st) {
      if (st._b) return; st._b = 1;
      var dots = $$('.dots i', st.parentNode);
      if (dots.length < 2) return;
      st.addEventListener('scroll', function () {
        var i = Math.round(st.scrollLeft / st.clientWidth);
        dots.forEach(function (d, j) { d.classList.toggle('on', j === i); });
      }, { passive: true });
    });
  }

  // ---- 좋아요 ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-like]');
    if (!b) return;
    e.preventDefault();
    if (needLogin()) return;
    var id = b.getAttribute('data-like');
    api('/api/posts/' + id + '/like').then(function (r) {
      if (!r.ok) return toast(r.error);
      $$('[data-like="' + id + '"]').forEach(function (x) {
        x.classList.toggle('liked', r.liked);
        var h = $('.heart', x); if (h) h.textContent = r.liked ? '♥' : '♡';
        var n = $('.n', x); if (n) n.textContent = r.n;
        if (r.liked) { x.classList.add('pop'); setTimeout(function () { x.classList.remove('pop'); }, 220); }
      });
    });
  });
  // 사진 두 번 누르면 좋아요
  document.addEventListener('dblclick', function (e) {
    var ph = e.target.closest('.ph[data-post]');
    if (!ph) return;
    var b = $('[data-like="' + ph.getAttribute('data-post') + '"]');
    if (b && !b.classList.contains('liked')) b.click();
  });

  // ---- 공유 ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-share]');
    if (!b) return;
    e.preventDefault();
    var url = location.origin + b.getAttribute('data-share');
    if (navigator.share) navigator.share({ title: '하월시아 클럽', url: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('주소를 복사했습니다.'); });
  });

  // ---- … 메뉴 ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-menu]');
    if (b) {
      e.preventDefault();
      var sh = $('#sheet-' + b.getAttribute('data-menu'));
      if (sh) sh.classList.add('on');
      return;
    }
    if (e.target.classList && e.target.classList.contains('sheet')) e.target.classList.remove('on');
    var c = e.target.closest('[data-close]');
    if (c) { var s = c.closest('.sheet'); if (s) s.classList.remove('on'); }
  });

  // ---- 일반 동작 버튼 (data-act="주소" data-body='{"a":1}' data-confirm="…" data-go="이동할 곳") ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    e.preventDefault();
    if (b.hasAttribute('data-login') && needLogin()) return;
    var cf = b.getAttribute('data-confirm');
    if (cf && !confirm(cf)) return;
    var body = {};
    try { body = JSON.parse(b.getAttribute('data-body') || '{}'); } catch (x) {}
    var ask = b.getAttribute('data-prompt');
    if (ask) { var v = prompt(ask, b.getAttribute('data-prompt-value') || ''); if (v === null) return; body[b.getAttribute('data-prompt-key') || 'value'] = v; }
    b.disabled = true;
    api(b.getAttribute('data-act'), body).then(function (r) {
      b.disabled = false;
      if (!r.ok) return toast(r.error || '실패했습니다.');
      if (b.getAttribute('data-done')) toast(b.getAttribute('data-done'));
      var go = b.getAttribute('data-go');
      if (go === 'reload') setTimeout(function () { location.reload(); }, 350);
      else if (go === 'back') setTimeout(function () { history.length > 1 ? history.back() : (location.href = B + '/'); }, 350);
      else if (go) setTimeout(function () { location.href = go.indexOf('/') === 0 ? B + go : go; }, 350);
      else if (r.url) setTimeout(function () { location.href = r.url; }, 350);
    });
  });

  // ---- 댓글 ----
  var cf = $('#cform');
  if (cf && !LOGGED) $('input', cf).addEventListener('click', needLogin);
  if (cf) cf.addEventListener('submit', function (e) {
    e.preventDefault();
    if (needLogin()) return;
    var inp = $('input', cf); var v = inp.value.trim();
    if (!v) return;
    var btn = $('button', cf); btn.disabled = true;
    api('/api/posts/' + cf.getAttribute('data-post') + '/comments', { body: v }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) return toast(r.error);
      location.reload();
    });
  });

  // ---- 더 보기 ----
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-more]');
    if (!b) return;
    e.preventDefault();
    b.disabled = true; b.textContent = '불러오는 중…';
    fetch(b.getAttribute('data-more'), { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (html) {
      var tmp = document.createElement('div'); tmp.innerHTML = html;
      var target = document.getElementById(b.getAttribute('data-target'));
      var nb = tmp.querySelector('[data-more]');
      $$('[data-more]', tmp).forEach(function (x) { x.parentNode.removeChild(x); });
      var holder = tmp.querySelector('.grid') || tmp;
      while (holder.firstChild) target.appendChild(holder.firstChild);
      bindStrips(target);
      if (nb) { b.setAttribute('data-more', nb.getAttribute('data-more')); b.disabled = false; b.textContent = '더 보기'; }
      else b.parentNode.removeChild(b);
    });
  });

  // =============================================================
  // # 자동완성 (글쓰기 칸)
  // =============================================================
  function bindTagInput(ta) {
    var box = document.createElement('div'); box.className = 'ac';
    ta.parentNode.appendChild(box);
    var items = [], sel = 0, tok = null, timer = null, seq = 0;
    function current() {
      var pos = ta.selectionStart, txt = ta.value.slice(0, pos);
      var m = /#([\p{L}\p{N}_]*)$/u.exec(txt);
      return m ? { start: pos - m[0].length, end: pos, q: m[1] } : null;
    }
    function hide() { box.style.display = 'none'; items = []; }
    function render() {
      if (!items.length) return hide();
      box.innerHTML = items.map(function (it, i) {
        return '<div data-i="' + i + '" class="' + (i === sel ? 'on' : '') + '"><b>#' + esc(it.word) + '</b>' +
          (it.ark ? ' <span class="a">방주</span>' : '') +
          '<small>' + (it.fresh ? '새 태그로 쓰기' : it.n ? it.n + '개 글' : (it.ark ? '방주 등재 품종' : '방주 품종명')) + '</small></div>';
      }).join('');
      box.style.display = 'block';
    }
    function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function pick(i) {
      var it = items[i]; if (!it || !tok) return;
      var v = ta.value;
      ta.value = v.slice(0, tok.start) + '#' + it.word + ' ' + v.slice(tok.end);
      var p = tok.start + it.word.length + 2;
      ta.setSelectionRange(p, p); ta.focus(); hide();
      ta.dispatchEvent(new Event('input'));
    }
    function lookup() {
      tok = current();
      if (!tok) return hide();
      var my = ++seq;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fetch(B + '/api/tags?q=' + encodeURIComponent(tok.q), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (r) {
          if (my !== seq) return;
          items = (r.list || []).slice(0, 8);
          // 지금 치고 있는 글자 그대로도 고를 수 있게 (새 품종명)
          if (tok && tok.q && !items.some(function (x) { return x.key === tok.q.toLowerCase(); })) items.push({ word: tok.q, key: tok.q.toLowerCase(), n: 0, ark: false, fresh: true });
          sel = 0; render();
        }).catch(hide);
      }, 140);
    }
    ta.addEventListener('input', lookup);
    ta.addEventListener('click', lookup);
    ta.addEventListener('keydown', function (e) {
      if (box.style.display !== 'block') return;
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { pick(sel); e.preventDefault(); }
      else if (e.key === 'Escape') hide();
    });
    box.addEventListener('mousedown', function (e) { var d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pick(+d.getAttribute('data-i')); } });
    ta.addEventListener('blur', function () { setTimeout(hide, 150); });
  }
  $$('textarea[data-tags]').forEach(bindTagInput);
  // 인기 태그 단추 → 글에 넣기
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-addtag]');
    if (!b) return;
    e.preventDefault();
    var ta = $('textarea[data-tags]'); if (!ta) return;
    var w = '#' + b.getAttribute('data-addtag');
    if (ta.value.indexOf(w) === -1) ta.value = (ta.value.replace(/\s+$/, '') + (ta.value.trim() ? ' ' : '') + w + ' ');
    ta.focus();
  });

  // =============================================================
  // 글쓰기 — 사진 줄여서 올리기
  // =============================================================
  var wf = $('#writeform');
  if (wf) {
    var shots = [];
    var thumbs = $('#thumbs');
    function drawThumbs() {
      thumbs.innerHTML = '';
      shots.forEach(function (s, i) {
        var d = document.createElement('div'); d.className = 't';
        d.innerHTML = '<img src="' + s.url + '" alt="">' + (i === 0 ? '<span class="one">대표</span>' : '') + '<button type="button" aria-label="빼기">✕</button>';
        d.querySelector('button').onclick = function () { URL.revokeObjectURL(s.url); shots.splice(i, 1); drawThumbs(); };
        thumbs.appendChild(d);
      });
      var c = $('#photocount'); if (c) c.textContent = shots.length ? shots.length + '/10장' : '';
    }
    function loadImg(file) {
      if (window.createImageBitmap) {
        return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(file); });
      }
      return new Promise(function (ok, no) { var im = new Image(); im.onload = function () { ok(im); }; im.onerror = no; im.src = URL.createObjectURL(file); });
    }
    function shrink(img, max, q) {
      var w = img.width, h = img.height, r = Math.min(1, max / Math.max(w, h));
      var c = document.createElement('canvas'); c.width = Math.round(w * r); c.height = Math.round(h * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return new Promise(function (ok) { c.toBlob(function (b) { ok({ blob: b, w: c.width, h: c.height }); }, 'image/jpeg', q); });
    }
    function addFiles(list) {
      var files = Array.prototype.slice.call(list || []);
      if (shots.length + files.length > 10) { toast('사진은 10장까지 올릴 수 있습니다.'); files = files.slice(0, 10 - shots.length); }
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          return loadImg(f).then(function (img) {
            return Promise.all([shrink(img, 1600, 0.86), shrink(img, 520, 0.8)]).then(function (r) {
              shots.push({ full: r[0].blob, thumb: r[1].blob, w: r[0].w, h: r[0].h, url: URL.createObjectURL(r[1].blob) });
              drawThumbs();
            });
          }).catch(function () {
            // 줄이기를 못 하는 사진(일부 HEIC 등)은 원본 그대로
            shots.push({ full: f, thumb: f, w: 0, h: 0, url: URL.createObjectURL(f) }); drawThumbs();
          });
        });
      });
    }
    $$('input[type=file]', wf).forEach(function (inp) {
      inp.addEventListener('change', function () { addFiles(inp.files); inp.value = ''; });
    });

    // 내 식물 고르기
    var plantId = wf.getAttribute('data-plant') || '';
    var newBox = $('#newplant');
    $$('.plpick button', wf).forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.plpick button', wf).forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        plantId = b.getAttribute('data-id');
        if (newBox) newBox.style.display = plantId === 'new' ? 'block' : 'none';
      });
    });

    wf.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = $('#body').value.trim();
      var editId = wf.getAttribute('data-edit');
      var err = $('#werr'); err.style.display = 'none';
      var fd = new FormData();
      fd.append('body', body);
      if (plantId === 'new') {
        var nm = $('#newplantname').value.trim();
        if (!nm) { err.textContent = '새 식물 이름을 적어 주세요.'; err.style.display = 'block'; return; }
        fd.append('new_plant', nm);
      } else if (plantId) fd.append('plant_id', plantId);
      var btn = $('#wsubmit'); btn.disabled = true;
      if (editId) {
        var o = { body: body }; if (plantId === 'new') o.new_plant = $('#newplantname').value.trim(); else if (plantId) o.plant_id = plantId;
        btn.textContent = '저장하는 중…';
        api('/api/posts/' + editId + '/edit', o).then(function (r) {
          if (!r.ok) { btn.disabled = false; btn.textContent = '저장하기'; err.textContent = r.error; err.style.display = 'block'; return; }
          location.href = r.url;
        });
        return;
      }
      if (!shots.length && !body) { btn.disabled = false; err.textContent = '사진이나 글을 넣어 주세요.'; err.style.display = 'block'; return; }
      shots.forEach(function (s, i) {
        fd.append('f' + i, s.full, 'p' + i + '.jpg');
        fd.append('t' + i, s.thumb, 't' + i + '.jpg');
        fd.append('w' + i, s.w); fd.append('h' + i, s.h);
      });
      var xhr = new XMLHttpRequest();
      xhr.open('POST', B + '/api/posts');
      xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) btn.textContent = '올리는 중… ' + Math.round(ev.loaded / ev.total * 100) + '%'; };
      xhr.onload = function () {
        var r = {}; try { r = JSON.parse(xhr.responseText); } catch (x) { r = { ok: false, error: '서버 응답 오류' }; }
        if (!r.ok) { btn.disabled = false; btn.textContent = '올리기'; err.textContent = r.error; err.style.display = 'block'; return; }
        location.href = r.url;
      };
      xhr.onerror = function () { btn.disabled = false; btn.textContent = '올리기'; err.textContent = '인터넷 연결을 확인해 주세요.'; err.style.display = 'block'; };
      btn.textContent = '올리는 중…';
      xhr.send(fd);
    });
  }

  // =============================================================
  // 로그인 (번호 → 인증번호 → 처음이면 닉네임)
  // =============================================================
  var lg = $('#login');
  if (lg) {
    var next = lg.getAttribute('data-next') || (B + '/');
    var phone = '', signup = '';
    var e1 = $('#lerr');
    function show(step) { $$('[data-step]', lg).forEach(function (x) { x.style.display = x.getAttribute('data-step') === step ? 'block' : 'none'; }); }
    function bad(m) { e1.textContent = m; e1.style.display = 'block'; }
    function good() { e1.style.display = 'none'; }
    $('#sendbtn').onclick = function () {
      phone = $('#phone').value; good();
      var b = this; b.disabled = true; b.textContent = '보내는 중…';
      api('/api/auth/send', { phone: phone }).then(function (r) {
        b.disabled = false; b.textContent = '인증번호 받기';
        if (!r.ok) return bad(r.error);
        show('code'); $('#code').focus();
        $('#sentto').textContent = phone;
        if (r.dev_code) { $('#code').value = r.dev_code; toast('시험 모드: 인증번호 ' + r.dev_code); }
      });
    };
    $('#resend').onclick = function (e) { e.preventDefault(); show('phone'); };
    $('#codebtn').onclick = function () {
      good(); var b = this; b.disabled = true;
      api('/api/auth/verify', { phone: phone, code: $('#code').value }).then(function (r) {
        b.disabled = false;
        if (!r.ok) return bad(r.error);
        if (r.signup) { signup = r.signup; show('nick'); $('#nick').focus(); return; }
        location.href = next;
      });
    };
    $('#nickbtn').onclick = function () {
      good(); var b = this; b.disabled = true;
      api('/api/auth/signup', { signup: signup, nick: $('#nick').value, agree: $('#agree').checked }).then(function (r) {
        b.disabled = false;
        if (!r.ok) return bad(r.error);
        if (r.ark) toast('방주 멤버로 확인되었습니다 ✦');
        setTimeout(function () { location.href = next; }, r.ark ? 900 : 0);
      });
    };
    ['phone', 'code', 'nick'].forEach(function (id) {
      var el = $('#' + id); if (!el) return;
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('#' + (id === 'phone' ? 'sendbtn' : id === 'code' ? 'codebtn' : 'nickbtn')).click(); } });
    });
  }

  // ---- 보증서 연결 ----
  var cform = $('#certform');
  if (cform) cform.addEventListener('submit', function (e) {
    e.preventDefault();
    var b = $('button', cform); b.disabled = true; b.textContent = '방주 장부에서 찾는 중…';
    api('/api/plants/' + cform.getAttribute('data-plant') + '/cert', { input: $('#certinput').value }).then(function (r) {
      b.disabled = false; b.textContent = '보증서 연결하기';
      if (!r.ok) return toast(r.error);
      toast(r.status === 'ok' ? '🛡 정품으로 연결되었습니다 (' + r.how + ')' : '연결 신청이 접수되었습니다. 운영자 확인 후 🛡 배지가 붙습니다.');
      setTimeout(function () { location.reload(); }, 1100);
    });
  });

  // ---- 홈 화면에 설치 ----
  var deferred = null;
  var bar = $('#install');
  function dismissed() { try { return localStorage.getItem('club_inst_x') === '1'; } catch (x) { return false; } }
  var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    if (bar && !dismissed() && !standalone) bar.classList.add('on');
  });
  if (bar && !standalone && !dismissed() && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
    $('.how', bar).textContent = '아래 공유 버튼 → 「홈 화면에 추가」';
    $('button.go', bar).style.display = 'none';
    bar.classList.add('on');
  }
  if (bar) {
    $('button.go', bar).onclick = function () { if (deferred) { deferred.prompt(); deferred = null; bar.classList.remove('on'); } };
    $('button.x', bar).onclick = function () { bar.classList.remove('on'); try { localStorage.setItem('club_inst_x', '1'); } catch (x) {} };
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(B + '/sw.js', { scope: B + '/' }).catch(function () {});

  bindStrips(document);
})();
